#!/usr/bin/env python3
"""
HTTP wrapper around the SpendTrack statement parsers.

Lets the app accept a dropped file in the BROWSER (Transactions -> Import). The
parsing and reconciliation live in parse_statements.py — this file adds only
transport, bank detection and a receipt-photo reader.

Deliberately imports `parse_statements` rather than reimplementing it: every parser
in there is validated against its statement's own printed totals. A reimplementation
is how the two drift apart.

Endpoints
  GET  /health              -> {"ok": true, "engine": "<engine>", "ollamaUp": bool}
  POST /parse    (file)     -> parsed + reconciled statement rows
  POST /receipt  (file)     -> one transaction read off a receipt photo by a local VLM

Run:  uvicorn statement_service:app --host 0.0.0.0 --port 8000
"""
import base64
import hmac
import io
import os
import re
import tempfile
import zipfile
from typing import Any

import httpx
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

import parse_statements as P
from bank_detect import (  # detection lives in bank_detect.py (shared)
    FORMAT_ACCOUNT,
    FORMAT_LABEL,
    detect_csv_text,
    detect_text,
)
from l10n_keywords import CURRENCY_CODES, NEVER_PAYABLE, PAYABLE_PRIORITY

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434")
VLM_MODEL = os.environ.get("SPENDTRACK_VLM_MODEL", "qwen2.5vl:7b")
MAX_BYTES = 25 * 1024 * 1024
# Multipart framing (boundary, part headers) on top of the file itself.
MULTIPART_OVERHEAD = 64 * 1024
# A PDF receipt's first page is rendered to an image for the vision model. The page
# size comes from the file (MediaBox), so cap the render: a page whose 150 dpi
# render would exceed this is drawn at a lower resolution instead.
MAX_RENDER_PIXELS = 25_000_000
RECEIPT_DPI = 150

try:  # decompression-bomb guard for every image PIL opens (pdfplumber renders via PIL)
    from PIL import Image as _PILImage

    _PILImage.MAX_IMAGE_PIXELS = MAX_RENDER_PIXELS * 2
except ImportError:  # pragma: no cover - Pillow ships with pdfplumber
    pass

# Which engine reads receipt images.
#   "ollama"     — local model on the host GPU. No cap, no cost, nothing leaves
#                  the machine. The default for exactly that reason.
#   "openrouter" — optional cloud fallback via OpenRouter's free vision models
#                  (needs OPENROUTER_API_KEY; free accounts are rate-limited per
#                  day). The receipt image LEAVES the machine on this engine.
RECEIPT_ENGINE = os.environ.get("SPENDTRACK_RECEIPT_ENGINE", "ollama").lower()
OPENROUTER_MODEL = os.environ.get(
    "SPENDTRACK_OPENROUTER_MODEL", "google/gemma-4-31b-it:free"
)
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

app = FastAPI(title="spendtrack-parser", docs_url=None, redoc_url=None)


@app.middleware("http")
async def _body_size_gate(request: Request, call_next):
    """Refuse an oversized upload from its Content-Length, BEFORE the multipart body
    is read and spooled to /tmp. An upload without a length (chunked) is refused
    too: the app always sends one."""
    if request.method == "POST":
        raw = request.headers.get("content-length")
        if raw is None:
            return JSONResponse({"error": "Content-Length required"}, status_code=411)
        try:
            declared = int(raw)
        except ValueError:
            return JSONResponse({"error": "Bad Content-Length"}, status_code=400)
        if declared > MAX_BYTES + MULTIPART_OVERHEAD:
            return JSONResponse({"error": "File too large (25MB max)"}, status_code=413)
    return await call_next(request)


# ───────────────────────── Trading 212 conventions ─────────────────────────
# Deposits/withdrawals/buys/sells are internal movement, not spending — imported
# raw, one active month of trading reads as tens of thousands of expenses. So they
# arrive pre-categorised as Transfers.
#
# Order types: Trading 212 exports `Market`, `Limit`, `Stop` and `Stop limit`
# buys/sells. Matching only market/limit would let a stop-loss sell vanish through
# a bare `continue`. Any buy or sell is a position
# change whatever the order type, dividends are income, and an action nobody has
# mapped is REPORTED (see `unknown`) instead of dropped.
def parse_trading212_csv(
    text: str, unknown: list[str] | None = None
) -> list[dict[str, Any]]:
    import csv as _csv

    rows: list[dict[str, Any]] = []
    for r in _csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        action = (r.get("Action") or "").strip()
        # Newer exports name the column `Time (UTC)`; reading only `Time` would skip
        # every row silently.
        date = (r.get("Time") or r.get("Time (UTC)") or r.get("Date") or "").strip()[:10]
        if not re.match(r"\d{4}-\d{2}-\d{2}$", date):
            if unknown is not None and any((v or "").strip() for v in r.values()):
                unknown.append(f"(no readable date) {action or '(blank action)'} {r.get('Total') or ''}")
            continue
        total = P.num(r.get("Total") or r.get("Total (EUR)") or "")
        if total is None or total == 0:
            continue
        ticker = (r.get("Ticker") or "").strip()
        result = (r.get("Result") or r.get("Result (EUR)") or "").strip()
        ccy = (r.get("Currency (Total)") or "EUR").strip().upper() or "EUR"
        a = action.lower()

        if a.startswith("deposit"):
            merch, amount, cat = "Deposit", abs(total), "transfers"
        elif a.startswith("withdrawal"):
            merch, amount, cat = "Withdrawal", -abs(total), "transfers"
        elif a.startswith("dividend"):
            # Before the buy/sell tests: "Dividend (Ordinary)" etc. are cash in.
            merch, amount, cat = f"Dividend {ticker}".strip(), abs(total), "other-income"
        elif re.search(r"\bbuy\b", a):
            # Label stays "Market buy" for every order type, so the ticker can be
            # read back out of this exact prefix.
            merch, amount, cat = f"Market buy {ticker}".strip(), -abs(total), "transfers"
        elif re.search(r"\bsell\b", a):
            label = f"Market sell {ticker}".strip()
            if result:
                label = f"{label} (realised {result})"
            merch, amount, cat = label, abs(total), "transfers"
        elif "interest" in a:
            merch, amount, cat = "Interest on cash", abs(total), "other-income"
        elif "card debit" in a:
            merch, amount, cat = "Card debit", -abs(total), "fees"
        elif "card cost" in a:
            # "New card cost" — the fee for issuing the Trading 212 card.
            merch, amount, cat = "New card cost", -abs(total), "fees"
        else:
            if unknown is not None:
                unknown.append(f"{date} {action or '(blank action)'} {total}")
            continue
        rows.append({
            "Date": date, "Merchant": merch, "Amount": round(amount, 2),
            "Currency": ccy, "Category": cat,
        })
    return rows


# ───────────────────────────── file handling ─────────────────────────────
def strip_bom(data: bytes) -> bytes:
    """Some banks export PDFs with a UTF-8 BOM before %PDF-, which makes pdfminer
    report 'No /Root object!' and skip the whole statement."""
    return data[3:] if data[:3] == b"\xef\xbb\xbf" else data


def pdf_to_markdown(path: str) -> str:
    from markitdown import MarkItDown

    return MarkItDown().convert(path).text_content


def unwrap_zip(data: bytes) -> tuple[bytes, str] | None:
    """Wise sometimes zips its statement. Return the first PDF/CSV inside.

    MAX_BYTES is checked against the UNCOMPRESSED size the zip declares — the
    upload cap only sees the compressed bytes, and a few MB of zeros inflates to
    gigabytes, which gets the container OOM-killed at its 1G limit."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for name in zf.namelist():
                if name.lower().endswith((".pdf", ".csv", ".md")):
                    if zf.getinfo(name).file_size > MAX_BYTES:
                        return None
                    return zf.read(name), name
    except Exception:
        return None
    return None


DATED_ROW = re.compile(
    r"(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[^\W\d_]{3})"
    r".*?\d[\d.,]*[.,]\d{2}"
)


def looks_like_receipt(text: str, pages: int) -> bool:
    """Distinguish an unrecognised RECEIPT from an unrecognised STATEMENT.

    Falling through to the vision model is safe for a one-page invoice and
    dangerous for a bank statement: the model would read a single number off a
    hundred-row document and report it confidently as one transaction. So the
    fall-through is gated on the shape of the document — few pages, few dated
    money rows. Anything statement-shaped raises the "which bank?" error instead,
    because a statement we cannot parse must fail loudly.
    """
    dated = len(DATED_ROW.findall(text))
    return pages <= 3 and dated < 8


def reconcile(rows: list[dict], totals: tuple | None) -> dict[str, Any]:
    """The check that makes this pipeline trustworthy: the parsed rows must add up
    to the totals the statement itself prints. Tolerance matches parse_statements."""
    out_sum = round(sum(-r["Amount"] for r in rows if r["Amount"] < 0), 2)
    in_sum = round(sum(r["Amount"] for r in rows if r["Amount"] > 0), 2)
    res: dict[str, Any] = {"out": out_sum, "in": in_sum, "checked": False, "ok": None}
    if totals and totals[0] is not None and totals[1] is not None:
        ok = abs(out_sum - totals[0]) < 0.5 and abs(in_sum - totals[1]) < 0.5
        res.update({
            "checked": True, "ok": ok,
            "statementOut": totals[0], "statementIn": totals[1],
            "detail": (f"out {out_sum} vs {totals[0]} | in {in_sum} vs {totals[1]} "
                       f"{'OK' if ok else '** MISMATCH **'}"),
        })
    else:
        res["detail"] = f"out {out_sum} | in {in_sum} (statement prints no totals)"
    return res


def ollama_up() -> bool:
    """Is the host Ollama answering? Informational only — see health()."""
    try:
        return httpx.get(f"{OLLAMA_URL}/api/tags", timeout=2.0).status_code == 200
    except Exception:
        return False


# Shared secret with the app (compose PARSER_TOKEN, header X-Parser-Token). The port is
# loopback-only, but without the token any local process could post uploads here (and
# spend an OpenRouter quota). Fail-closed: no token or a weak/placeholder one → 503,
# missing/wrong → 401.
PARSER_TOKEN = os.environ.get("PARSER_TOKEN", "")
PARSER_TOKEN_MIN = 16
# Same list as KNOWN_WEAK in src/lib/weak-secret.ts (covers every .env.example value).
WEAK_MARKERS = ("changeme", "change-me", "placeholder", "your-secret", "min_32_chars", "example-secret")


def is_weak_secret(value: str, min_length: int) -> bool:
    if not value or len(value) < min_length:
        return True
    v = value.lower()
    return any(w in v for w in WEAK_MARKERS)


def _auth(request: Request) -> JSONResponse | None:
    if is_weak_secret(PARSER_TOKEN, PARSER_TOKEN_MIN):
        return JSONResponse(
            {"error": "PARSER_TOKEN is not configured or is a weak/placeholder value"},
            status_code=503)
    presented = request.headers.get("x-parser-token", "")
    if not presented or not hmac.compare_digest(presented.encode(), PARSER_TOKEN.encode()):
        return JSONResponse({"error": "bad parser token"}, status_code=401)
    return None


@app.get("/health")
def health() -> dict[str, Any]:
    # `ok` is about THIS service and is what the Docker healthcheck reads; statements
    # parse fine with Ollama down, so `ollamaUp` must never turn it false. It is here
    # so a down Ollama is visible instead of receipts failing silently. No URLs, model names or key
    # state: the port is unauthenticated on loopback.
    return {"ok": True, "engine": RECEIPT_ENGINE, "ollamaUp": ollama_up()}


@app.post("/parse")
async def parse(request: Request, file: UploadFile = File(...)) -> JSONResponse:
    denied = _auth(request)
    if denied:
        return denied
    data = await file.read()
    if not data:
        return JSONResponse({"error": "Empty file"}, status_code=400)
    if len(data) > MAX_BYTES:
        return JSONResponse({"error": "File too large (25MB max)"}, status_code=413)

    name = file.filename or "upload"
    if name.lower().endswith(".zip"):
        inner = unwrap_zip(data)
        if not inner:
            return JSONResponse({"error": "Zip contained no PDF or CSV"}, status_code=422)
        data, name = inner

    data = strip_bom(data)
    lower = name.lower()
    warnings: list[str] = []
    rows: list[dict[str, Any]] = []
    totals = None
    fmt: str | None = None
    unknown_actions: list[str] = []

    # ── CSV / text ──
    if not lower.endswith(".pdf") and data[:4] != b"%PDF":
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("latin-1")
        fmt = detect_csv_text(text)

        if fmt in ("revolut_csv", "wise_csv"):
            # Both native exports carry a running balance, so both get the
            # balance-chain replay - the strongest check in the pipeline.
            csv_parser = P.parse_wise_csv if fmt == "wise_csv" else P.parse_revolut_csv
            with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False,
                                             encoding="utf-8", newline="") as fh:
                fh.write(text)
                tmp = fh.name
            try:
                rows, chain_ok = csv_parser(tmp)
            except ValueError as e:
                return JSONResponse(
                    {"error": f"{FORMAT_LABEL[fmt]}: {str(e)[:160]}", "format": fmt},
                    status_code=422)
            finally:
                os.unlink(tmp)
            chain = {True: "balance-chain OK", False: "** BALANCE-CHAIN MISMATCH **",
                     None: "(no balance data)"}[chain_ok]
            out_sum = round(sum(-r["Amount"] for r in rows if r["Amount"] < 0), 2)
            in_sum = round(sum(r["Amount"] for r in rows if r["Amount"] > 0), 2)
            return JSONResponse({
                "format": fmt, "label": FORMAT_LABEL[fmt],
                "account": FORMAT_ACCOUNT[fmt], "rows": rows,
                "validation": {"checked": chain_ok is not None, "ok": chain_ok,
                               "out": out_sum, "in": in_sum,
                               "detail": f"out {out_sum} | in {in_sum} | {chain}"},
                "warnings": warnings, "source": name,
            })

        if fmt == "trading212_csv":
            rows = parse_trading212_csv(text, unknown_actions)
            if unknown_actions:
                warnings.append(
                    f"Trading 212: {len(unknown_actions)} row(s) with an action this "
                    "parser does not know were NOT imported — " + "; ".join(unknown_actions[:10])
                )
            warnings.append(
                "Trading 212: deposits, withdrawals, buys and sells are tagged Transfers "
                "(internal movement, not spending) — only interest and card fees count."
            )

        else:
            # Not one of the known bank exports. The app's own CSV importer handles
            # generic files, so hand it back rather than guessing.
            return JSONResponse({
                "format": None, "label": None, "account": None, "rows": [],
                "fallback": "generic-csv", "source": name,
                "warnings": ["Unrecognised CSV layout — using the generic column mapper."],
            })

    # ── PDF ──
    else:
        with tempfile.NamedTemporaryFile("wb", suffix=".pdf", delete=False) as fh:
            fh.write(data)
            tmp = fh.name
        try:
            try:
                md = pdf_to_markdown(tmp)
            except Exception as e:
                return JSONResponse(
                    {"error": f"Could not read the PDF: {str(e)[:120]}"}, status_code=422)

            fmt = detect_text(md)
            if fmt is None:
                # markitdown flattens some layouts; the word-cluster view often
                # still carries the bank name.
                try:
                    fmt = detect_text("\n".join(P.reconstruct_pdf_lines(tmp)))
                except Exception:
                    fmt = None
            if fmt is None:
                try:
                    import pdfplumber

                    with pdfplumber.open(tmp) as pdf:
                        pages = len(pdf.pages)
                except Exception:
                    pages = 1
                if looks_like_receipt(md, pages):
                    # A one-page invoice, not a bank export. Hand it to the
                    # receipt reader rather than erroring — this is what people
                    # actually drop most often.
                    return JSONResponse({
                        "format": None, "label": None, "account": None, "rows": [],
                        "fallback": "receipt", "source": name,
                    })
                return JSONResponse(
                    {"error": "Could not tell which bank this statement is from.",
                     "hint": "Example parsers are included for Revolut, Wise and American Express statements (PDF or CSV), plus Trading 212 CSV."},
                    status_code=422)

            if fmt in ("revolut_md", "amex_layout_a", "amex_layout_b", "wise"):
                parser = {"revolut_md": P.parse_revolut, "amex_layout_a": P.parse_amex_layout_a,
                          "amex_layout_b": P.parse_amex_layout_b, "wise": P.parse_wise}[fmt]
                try:
                    rows, totals = parser(md)
                except ValueError as e:
                    # e.g. a card statement without its billing-period line: the parser refuses
                    # to guess a year. That is a 422 with the reason, not a 500.
                    return JSONResponse(
                        {"error": f"{FORMAT_LABEL.get(fmt, fmt)}: {str(e)[:160]}", "format": fmt},
                        status_code=422)
        finally:
            os.unlink(tmp)

    # A file that exists but yields nothing is an ERROR, not an empty month: a
    # layout the parser does not know would otherwise lose a whole month of rows
    # while printing a clean run.
    if not rows:
        return JSONResponse({
            "error": (f"Recognised this as {FORMAT_LABEL.get(fmt, fmt)} but parsed 0 "
                      "transactions. That is a parser failure, not an empty statement — "
                      "do not treat it as nothing to import."),
            "format": fmt,
        }, status_code=422)

    for r in rows:
        r.setdefault("Source", name)

    validation = reconcile(rows, totals)
    if unknown_actions:
        # Rows the parser could not classify are missing from `rows`, so the
        # verdict must say so — a clean-looking result with money left out is the
        # failure this whole service exists to prevent.
        validation["unknownActions"] = unknown_actions
        validation["detail"] += (f" | ** {len(unknown_actions)} UNKNOWN ACTION ROW(S) "
                                 "NOT IMPORTED **")

    return JSONResponse({
        "format": fmt, "label": FORMAT_LABEL.get(fmt, fmt),
        "account": FORMAT_ACCOUNT.get(fmt), "rows": rows,
        "validation": validation, "warnings": warnings, "source": name,
    })


# ───────────────────────────── receipt reader ─────────────────────────────
RECEIPT_SYSTEM = (
    "You read receipts and invoices and return STRICT JSON only. No prose, no code "
    "fences. If a field is not visible on the receipt, use null — never invent a value."
)

RECEIPT_PROMPT = """Read this receipt or invoice and return JSON with exactly these keys:

{"vendor": string|null,        // the shop or company name as printed
 "date": string|null,          // ISO yyyy-mm-dd, the transaction date
 "amount": number|null,        // the TOTAL actually paid, as a positive number
 "currency": string|null,      // 3-letter code, e.g. EUR, GBP, CHF, USD
 "type": "EXPENSE"|"INCOME",
 "note": string|null,          // what was bought, one short line
 "confidence": number}         // 0.0-1.0, how sure you are of amount and date

Rules:
- amount is the grand total paid, NOT a subtotal, NOT the VAT line, NOT a single item.
- If part of the bill was paid, take the part actually paid NOW, not the full bill.
  A line like "amount due now", "deposit" or "part payment" (in whatever language
  the receipt is printed) is the amount; the invoice total above it is NOT.
- Where a tip, discount or cash rounding changes the figure, take the FINAL line
  ("grand total", "amount due"), not the line above it.
- currency is the currency the card or cash was actually charged in — the one
  attached to the payable line. A receipt often ALSO prints an approximate
  conversion ("≈ €4.60", "approx.", a rate like 1.0850). That converted figure is
  NOT the amount and its currency is NOT the currency. Ignore it entirely.
- Read the year from the receipt. If the year is unclear, still return the day and
  month with the year you can best read — do not guess a year from memory.
- A refund or credit note is type INCOME; everything else is EXPENSE.
- confidence must be LOWER than 0.7 whenever the total, the date or the currency is
  blurred, cropped, ambiguous or inferred rather than plainly legible.
- Return the JSON object and nothing else."""


# A receipt prints its currency as a symbol or a local word, and the model echoes
# what it sees. Passing that straight through would store a symbol as the currency
# code. Every ISO code in CURRENCY_CODES maps to itself; the rest are symbols.
CCY_ALIASES = {
    **{code: code for code in CURRENCY_CODES},
    "€": "EUR", "EURO": "EUR", "EUROS": "EUR",
    "£": "GBP", "$": "USD", "US$": "USD",
    "¥": "JPY", "₹": "INR", "₩": "KRW", "R$": "BRL", "FR.": "CHF",
}


def coerce_date(value: Any) -> str | None:
    """Normalise whatever date the model echoed off the receipt to ISO.

    Receipts print dates as 12/07/2026 or 12-05-2026, and the model reports what
    it sees. Demanding ISO would throw away a date the model had read correctly.

    Day-first when ambiguous — the more common convention on printed receipts.
    """
    if not isinstance(value, str):
        return None
    s = value.strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        y, mo, dy = (int(x) for x in m.groups())
    else:
        m = re.match(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})", s)
        if not m:
            return None
        dy, mo, y = (int(x) for x in m.groups())
        if y < 100:
            y += 2000
        # Unambiguously month-first only when the first field cannot be a day.
        if dy > 12 and mo <= 12:
            pass
        elif mo > 12 and dy <= 12:
            dy, mo = mo, dy
    import datetime

    if not 2000 <= y <= 2099:
        return None
    try:
        # Calendar-valid, not merely in range: 31/02 must not reach the database.
        return datetime.date(y, mo, dy).isoformat()
    except ValueError:
        return None


class ReceiptReply(BaseModel):
    """What pass 1 may say. Unknown keys are dropped, wrong types are a ValueError
    (pydantic's ValidationError subclasses it) instead of a silent `.get()`."""
    model_config = ConfigDict(extra="ignore")
    vendor: str | None = None
    date: str | int | None = None
    amount: float | str | None = None
    currency: str | None = None
    type: str | None = None
    note: str | None = None
    confidence: float | str | None = None


class AmountLine(BaseModel):
    model_config = ConfigDict(extra="ignore")
    label: str | None = None
    amount: float | str | None = None
    currency: str | None = None


class AmountLinesReply(BaseModel):
    """What pass 2 may say: every labelled amount, the choice is made in code."""
    model_config = ConfigDict(extra="ignore")
    lines: list[AmountLine] = []


def coerce_receipt(raw: str) -> dict[str, Any]:
    """Pull the JSON object out of whatever the model returned."""
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        raise ValueError(f"model returned no JSON: {raw[:200]}")
    d = ReceiptReply.model_validate_json(m.group(0)).model_dump()

    amount = d.get("amount")
    if isinstance(amount, str):
        amount = P.num(amount)
    if amount is not None:
        amount = abs(round(float(amount), 2))

    date = coerce_date(d.get("date"))

    ccy = d.get("currency")
    if isinstance(ccy, str):
        key = ccy.strip().upper()
        ccy = CCY_ALIASES.get(key) or CCY_ALIASES.get(key[:3]) or (
            key[:3] if re.fullmatch(r"[A-Z]{3}", key[:3]) else None)

    ttype = str(d.get("type") or "EXPENSE").upper()
    if ttype not in ("EXPENSE", "INCOME"):
        ttype = "EXPENSE"

    conf = d.get("confidence")
    try:
        conf = max(0.0, min(1.0, float(conf)))
    except (TypeError, ValueError):
        conf = None

    return {
        "vendor": (d.get("vendor") or None),
        "date": date,
        "amount": amount,
        "currency": ccy,
        "type": ttype,
        "note": (d.get("note") or None),
        "confidence": conf,
    }


# ── Pass 2: read the labels, decide in code ────────────────────────────────
# Measured on a synthetic bench: the model reads text almost perfectly (12/12 vendors and
# amounts on clean receipts) but picks the WRONG line when several totals compete
# — it returned the 1,000.00 invoice total instead of the 250.00 actually paid. So
# the model is asked only to transcribe every labelled amount, and the choice of
# which one is payable is made here, by rule. Reading is what it is good at;
# choosing is what it is bad at.
AMOUNT_LINES_PROMPT = """List EVERY labelled money amount printed on this receipt.

Return STRICT JSON only:
{"lines": [{"label": string, "amount": number, "currency": string}]}

- label = the text printed next to the amount, copied exactly as it appears.
- Include every one: subtotal, VAT/tax, discount, tip, rounding, service charge,
  invoice total, total, grand total, amount due, amount due now, deposit, balance,
  and any approximate currency conversion.
- Do NOT include per-item line prices, only labelled totals and adjustments.
- Do NOT decide which one was paid. Just transcribe them all.
- JSON only."""

# The label patterns — PAYABLE_PRIORITY (highest priority first; the first pattern
# that matches a label wins) and NEVER_PAYABLE — are the localised tables in
# l10n_keywords.py.


def clean_lines(lines: list[dict]) -> list[dict]:
    """Pass-2 lines as {label, amount: float, currency} — for the app's split prefill.

    A string amount ("4,17") is parsed like the statement parsers do; a line with no
    label or no readable amount is dropped. The sign is kept (a discount stays
    negative); the app decides which lines are items.
    """
    out: list[dict] = []
    for ln in lines or []:
        label = str(ln.get("label") or "").strip()
        amt = ln.get("amount")
        if isinstance(amt, str):
            amt = P.num(amt)
        if amt is None or not label:
            continue
        try:
            amt = round(float(amt), 2)
        except (TypeError, ValueError):
            continue
        ccy = ln.get("currency")
        out.append({"label": label[:120], "amount": amt,
                    "currency": ccy.strip().upper()[:8] if isinstance(ccy, str) else None})
    return out


def choose_payable(lines: list[dict]) -> dict | None:
    """Pick the amount actually paid from transcribed label/amount pairs."""
    cands = []
    for idx, ln in enumerate(lines or []):
        label = str(ln.get("label") or "").strip()
        amt = ln.get("amount")
        if isinstance(amt, str):
            amt = P.num(amt)
        if amt is None or not label:
            continue
        try:
            amt = abs(round(float(amt), 2))
        except (TypeError, ValueError):
            continue
        if amt == 0 or NEVER_PAYABLE.search(label):
            continue
        for rank, (name, pat) in enumerate(PAYABLE_PRIORITY):
            if re.search(pat, label, re.I):
                cands.append((rank, -idx, name, amt, ln.get("currency"), label))
                break
    if not cands:
        return None
    # Rank first; on a tie the LATER line wins, because totals are printed after
    # the items they total.
    cands.sort(key=lambda c: (c[0], c[1]))
    rank, _neg_idx, name, amt, ccy, label = cands[0]
    return {"amount": amt, "currency": ccy, "label": label, "rule": name}


class EngineError(Exception):
    def __init__(self, message: str, status: int = 502, hint: str | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.hint = hint


async def read_via_ollama(data: bytes, prompt: str = RECEIPT_PROMPT,
                          system: str | None = RECEIPT_SYSTEM) -> tuple[str, str]:
    """Local model on the host GPU. No quota, no cost, image never leaves the box."""
    payload = {
        "model": VLM_MODEL,
        "prompt": prompt,
        "images": [base64.b64encode(data).decode("ascii")],
        "stream": False,
        "format": "json",
        # Ollama defaults to a 4096-token context. A full-page invoice rendered
        # above ~150 dpi overflows it and the request fails outright with
        # "request (4181 tokens) exceeds the available context size (4096)",
        # which surfaces as an unexplained 400 on exactly the biggest photos.
        "options": {"temperature": 0, "num_ctx": 8192},
    }
    if system:
        payload["system"] = system
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            r = await client.post(f"{OLLAMA_URL}/api/generate", json=payload)
    except httpx.HTTPError as e:
        raise EngineError(
            f"Local vision model unreachable at {OLLAMA_URL}: {str(e)[:120]}",
            503,
            f"Is Ollama running? `ollama serve`, then `ollama pull {VLM_MODEL}`",
        )
    if r.status_code != 200:
        raise EngineError(f"Vision model error {r.status_code}: {r.text[:200]}")
    return r.json().get("response", ""), VLM_MODEL


async def read_via_openrouter(data: bytes, prompt: str = RECEIPT_PROMPT,
                              system: str | None = RECEIPT_SYSTEM) -> tuple[str, str]:
    """Optional cloud lane via OpenRouter. Free models are rate-limited per day, and
    the image leaves the machine — off unless SPENDTRACK_RECEIPT_ENGINE=openrouter."""
    if not OPENROUTER_KEY:
        raise EngineError(
            "OpenRouter engine selected but OPENROUTER_API_KEY is not set.",
            503,
            "Add OPENROUTER_API_KEY to .env, then "
            "`docker compose up -d spendtrack-parser`.",
        )
    b64 = base64.b64encode(data).decode("ascii")
    payload = {
        "model": OPENROUTER_MODEL,
        "temperature": 0,
        "messages": ([{"role": "system", "content": system}] if system else []) + [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"},
                    },
                ],
            },
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            r = await client.post(
                OPENROUTER_URL,
                json=payload,
                headers={"Authorization": f"Bearer {OPENROUTER_KEY}"},
            )
    except httpx.HTTPError as e:
        raise EngineError(f"OpenRouter unreachable: {str(e)[:120]}", 503)
    if r.status_code == 429:
        raise EngineError(
            "OpenRouter free lane is rate-limited (50 requests/day, shared "
            "account-wide). Switch to the local engine or wait for the 00:00 UTC reset.",
            429,
            "SPENDTRACK_RECEIPT_ENGINE=ollama uses the local model, which has no cap.",
        )
    if r.status_code != 200:
        raise EngineError(f"OpenRouter error {r.status_code}: {r.text[:200]}")
    body = r.json()
    try:
        return body["choices"][0]["message"]["content"], OPENROUTER_MODEL
    except (KeyError, IndexError):
        raise EngineError(f"Unexpected OpenRouter response: {str(body)[:200]}")


def receipt_render_dpi(width_pt: float, height_pt: float) -> float:
    """Resolution for rendering a receipt page: RECEIPT_DPI, lowered so the image
    stays within MAX_RENDER_PIXELS however large the page claims to be."""
    w_in, h_in = max(float(width_pt), 1.0) / 72.0, max(float(height_pt), 1.0) / 72.0
    fit = (MAX_RENDER_PIXELS / (w_in * h_in)) ** 0.5
    return min(float(RECEIPT_DPI), fit)


@app.post("/receipt")
async def receipt(request: Request, file: UploadFile = File(...)) -> JSONResponse:
    denied = _auth(request)
    if denied:
        return denied
    data = await file.read()
    if not data:
        return JSONResponse({"error": "Empty file"}, status_code=400)
    if len(data) > MAX_BYTES:
        return JSONResponse({"error": "File too large (25MB max)"}, status_code=413)

    name = (file.filename or "receipt").lower()
    # A PDF receipt is rendered to an image first — the VLM reads pixels, and a
    # scanned invoice has no text layer to extract anyway.
    if name.endswith(".pdf") or data[:4] == b"%PDF":
        try:
            import pdfplumber

            with tempfile.NamedTemporaryFile("wb", suffix=".pdf", delete=False) as fh:
                fh.write(strip_bom(data))
                tmp = fh.name
            try:
                with pdfplumber.open(tmp) as pdf:
                    page = pdf.pages[0]
                    img = page.to_image(resolution=receipt_render_dpi(page.width, page.height))
                    buf = io.BytesIO()
                    img.original.save(buf, format="PNG")
                    data = buf.getvalue()
            finally:
                os.unlink(tmp)
        except Exception as e:
            return JSONResponse(
                {"error": f"Could not render the PDF receipt: {str(e)[:120]}"},
                status_code=422)

    # The engine comes from the environment ONLY. A per-request override let any
    # local process send a receipt off the box on a port that has no auth.
    engine = RECEIPT_ENGINE
    read = read_via_openrouter if engine == "openrouter" else read_via_ollama
    try:
        raw, used_model = await read(data)
    except EngineError as e:
        return JSONResponse({"error": e.message, "hint": e.hint}, status_code=e.status)

    try:
        parsed = coerce_receipt(raw)
    except Exception as e:
        return JSONResponse(
            {"error": f"Could not read a transaction off that image: {str(e)[:160]}"},
            status_code=422)

    if parsed["amount"] is None:
        return JSONResponse(
            {"error": "No total found on that receipt — enter it by hand.",
             "partial": parsed}, status_code=422)

    # Pass 2 — transcribe every labelled amount, then choose by rule. This is what
    # gets a part-payment right: pass 1 reads the loudest number, this reads the
    # labels. A disagreement between the two is the only honest uncertainty signal
    # available, since the model's own `confidence` never tracked correctness.
    # Retried once: the transcription is not deterministic even at temperature 0.
    # A total line the model lists on one run can simply be absent on the next,
    # which silently removes the cross-check while looking exactly like a receipt
    # that has no total to check.
    picked = None
    lines_out: list[dict] = []
    for attempt in range(2):
        try:
            raw2, _ = await read(data, AMOUNT_LINES_PROMPT, None)
            m2 = re.search(r"\{.*\}", raw2, re.S)
            if m2:
                lines_out = [ln.model_dump() for ln in AmountLinesReply.model_validate_json(m2.group(0)).lines]
                picked = choose_payable(lines_out)
        except (EngineError, ValueError, TypeError) as e:
            parsed["passTwoError"] = str(e)[:120]
        if picked:
            break

    # Every labelled amount pass 2 transcribed — the app's split editor (F3) turns
    # the item lines into parts ("prefill from receipt"). Read-only data; the
    # payable choice above is unaffected.
    parsed["lines"] = clean_lines(lines_out)
    parsed["agrees"] = None
    if picked:
        parsed["labelled"] = {"amount": picked["amount"], "label": picked["label"],
                              "rule": picked["rule"]}
        agrees = abs(picked["amount"] - (parsed["amount"] or 0)) < 0.005
        parsed["agrees"] = agrees
        if not agrees:
            # Trust the labelled read: it is the one that looked at what the line
            # is CALLED rather than how big it is printed.
            parsed["passOneAmount"] = parsed["amount"]
            parsed["amount"] = picked["amount"]
            if isinstance(picked.get("currency"), str):
                key = picked["currency"].strip().upper()
                parsed["currency"] = (CCY_ALIASES.get(key)
                                      or CCY_ALIASES.get(key[:3]) or parsed["currency"])

    parsed["model"] = used_model
    parsed["engine"] = engine
    return JSONResponse(parsed)
