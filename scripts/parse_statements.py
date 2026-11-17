#!/usr/bin/env python3
"""
Example bank-statement parsers for SpendTrack (Revolut, Wise, American Express,
Trading 212).

Used as a library by the parser sidecar (`statement_service.py`): a PDF goes through
markitdown to markdown, then through the per-bank parser; a bank's own CSV export is
read directly. Each parser is validated against the statement's OWN "money in / out"
totals (or, for CSV exports, the running balance chain), so a statement that does not
reconcile is flagged instead of being imported silently wrong.

Rows are dicts: Date (YYYY-MM-DD), Merchant, Amount (signed: negative = expense,
positive = income), Currency.

Every language-dependent word (month names, column headers, credit markers) lives
in `l10n_keywords.py`; the parsers below hold layout logic only.
"""
import csv
import re

from l10n_keywords import (
    CARD_TRANSACTION_RE,
    CREDIT_MARKER_RE,
    DECIMAL_COMMA_MARKER_RE,
    MONTH_WORD_RE,
    PERIOD_RE,
    STATEMENT_HEADING_RE,
    has_summary_header,
    month_index,
)


def to_iso(d):
    """'12 Feb 2026' -> '2026-02-12' ; '27. <month name> 2026' in any table
    language -> '2026-07-27' ; 'Jun 6, 2026' -> '2026-06-06'.

    A statement is rendered in the language chosen at download time, and some
    templates print the month first with a comma after the day. A date form that
    is not recognised here yields 0 rows for the whole statement, so all three
    shapes are accepted.
    """
    m = re.match(r"(\d{1,2})\.?\s+(?:de\s+)?([^\W\d_]+)\.?\s+(?:de\s+)?(\d{4})", d)
    if not m:
        m_us = re.match(r"([^\W\d_]+)\.?\s+(\d{1,2}),\s+(\d{4})", d)
        if not m_us:
            return None
        idx = month_index(m_us.group(1))
        return f"{int(m_us.group(3)):04d}-{idx:02d}-{int(m_us.group(2)):02d}" if idx else None
    day, yr = int(m.group(1)), int(m.group(3))
    idx = month_index(m.group(2))
    if not idx:
        return None
    return f"{yr:04d}-{idx:02d}-{day:02d}"


def num(s):
    """'1,908.50' -> 1908.5 ; '1.908,50' -> 1908.5 ; '12 000.00' -> 12000.0."""
    s = s.strip().replace(" ", "").replace(" ", "")  # strip space / NBSP thousands-seps
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        parts = s.split(",")
        s = s.replace(",", ".") if len(parts) == 2 and len(parts[1]) <= 2 else s.replace(",", "")
    try:
        return round(float(s), 2)
    except ValueError:
        return None


# ───────────────────────── Revolut ─────────────────────────
def parse_revolut(text):
    cm = re.search(r"\b(EUR|GBP|USD|CHF)\s+Statement", text)
    ccy = cm.group(1) if cm else "EUR"
    sym = {"EUR": "€", "GBP": "£", "USD": "$", "CHF": "CHF"}.get(ccy, "€")
    # allow space/NBSP thousands separators ("€12 000.00")
    amt_re = re.escape(sym) + r"\s?([\d][\d.,\s]*[.,]\d{2})"
    # "12 Feb 2026" or "Jun 6, 2026", depending on the template. September can be
    # printed "Sept" (4 letters), so the month takes 3 or 4 letters.
    date_re = r"(\d{1,2}\s+[A-Z][a-z]{2,3}\s+\d{4}|[A-Z][a-z]{2,3}\s+\d{1,2},\s+\d{4})"

    # Statement totals for validation. A multi-period statement repeats
    # "Balance summary ... Total" once PER SECTION, so the totals are the SUM of
    # every Total row — reading only the first one flags a false mismatch. Each
    # section also prints an "Account (E-Money)" row with the same figures; that
    # row is only the fallback for a statement with no Total row at all.
    tot = None
    out_sum = in_sum = 0.0
    hits = 0
    fallback = None
    for line in text.split("\n"):
        if not re.search(r"\b(Total|Account \(E-Money\))\b", line):
            continue
        a = re.findall(amt_re, line)
        if len(a) < 4:
            continue
        if re.search(r"\bTotal\b", line):
            out_sum += num(a[-3]) or 0.0
            in_sum += num(a[-2]) or 0.0
            hits += 1
        elif fallback is None:
            fallback = (num(a[-3]), num(a[-2]))
    if hits:
        tot = (round(out_sum, 2), round(in_sum, 2))
    elif fallback:
        tot = fallback

    rows = []
    for raw in text.split("\n"):
        line = raw.replace("|", " ")
        dm = re.search(r"^\s*" + date_re, line)
        if not dm:
            continue
        amts = re.findall(amt_re, line)
        if len(amts) < 2:           # need at least txn amount + balance
            continue
        date = to_iso(dm.group(1))
        if not date:
            continue
        amount = num(amts[-2])      # 2nd-to-last = txn amount, last = balance
        if amount is None or amount == 0:
            continue
        # description = text between the date and the first amount
        after = line[dm.end():]
        desc = re.split(amt_re, after)[0]
        desc = re.sub(r"\s+", " ", desc).strip(" -")[:120] or "(unknown)"
        d = desc.lower()
        is_in = (
            d.startswith("payment from") or d.startswith("transfer from")
            or d.startswith("refund") or "cashback" in d or "reward" in d
            or "money added" in d or "top-up" in d or "top up" in d
            or d.startswith("received")  # money received from another account
            or (d.startswith("exchanged to") and ccy.lower() in d)
        )
        rows.append({
            "Date": date,
            "Merchant": desc,
            "Amount": amount if is_in else -amount,
            "Currency": ccy,
        })
    return rows, tot


# ───────────────────── American Express, layout A ─────────────────────
# Numeric DD.MM dates and decimal commas. Transaction rows come in TWO shapes:
# markitdown usually renders the statement page as a markdown table, but when a
# charge carries a wrapped detail block under the row the table detection
# collapses and that page emits PLAIN TEXT instead. Both shapes must be accepted,
# or those charges are dropped silently.
_LAYOUT_A_PIPE = re.compile(r"^\|\s*(\d{2})\.(\d{2})\s*\|\s*(\d{2})\.(\d{2})\s*\|\s*(.*)$")
_LAYOUT_A_PLAIN = re.compile(r"^\s*(\d{2})\.(\d{2})\s+(\d{2})\.(\d{2})\s+(\S.*)$")


def _layout_a_row(line):
    """Match a layout-A transaction row in either the table or plain-text shape."""
    return _LAYOUT_A_PIPE.match(line) or _LAYOUT_A_PLAIN.match(line)


def parse_amex_layout_a(text):
    import datetime as _dt
    pm = PERIOD_RE.search(text)
    if not pm:
        # Rows print DD.MM only; the year comes from this line. A hard-coded
        # fallback year would date a whole statement wrong while its totals still
        # reconciled (totals do not depend on dates). Fail loudly instead.
        raise ValueError("billing period '<from> DD.MM.YY <to> DD.MM.YY' not found - cannot year-stamp rows")
    start_y, end_y = 2000 + int(pm.group(3)), 2000 + int(pm.group(6))
    p_start = _dt.date(start_y, int(pm.group(2)), int(pm.group(1)))
    p_end = _dt.date(end_y, int(pm.group(5)), int(pm.group(4)))

    # totals: the row under the "... credits ... debits ... new balance" header
    credits = debits = None
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if has_summary_header(line):
            for j in range(i + 1, min(i + 4, len(lines))):
                a = re.findall(r"(\d[\d.]*,\d{2})", lines[j])
                if len(a) >= 4:
                    credits, debits = num(a[1]), num(a[2])  # last balance, credits, debits, new balance
                    break
            break

    rows = []
    for idx, line in enumerate(lines):
        m = _layout_a_row(line)
        if not m:
            continue
        dd, mm = int(m.group(1)), int(m.group(2))
        rest = m.group(5)
        amts = re.findall(r"(\d[\d.]*,\d{2})", rest)
        amount = num(amts[-1]) if amts else None
        if amount is None or amount == 0:
            # Wrapped-amount row: the charge wrapped onto the next line as a
            # standalone amount, e.g. "EXAMPLE STORE  TOWN" then "16,50".
            # Look ahead until the next transaction row; take the first standalone amount.
            for nl in lines[idx + 1 : idx + 3]:
                if _layout_a_row(nl):
                    break  # next transaction row — give up
                sa = re.fullmatch(r"\s*(\d[\d.]*,\d{2})\s*", nl)
                if sa:
                    amount = num(sa.group(1))
                    break
        if amount is None or amount == 0:
            continue
        if "|" in rest:
            details = re.split(r"\|", rest)[0]
        else:
            # Plain-text row: the amount columns are just trailing tokens, so cut
            # them off or they end up inside the merchant name. The charged amount
            # uses a comma decimal ("202,50"); an optional foreign-currency amount
            # sits before it with a dot decimal ("145.00"). Requiring the dot form
            # keeps a merchant that genuinely ends in digits intact.
            details = re.sub(r"\s+\d[\d.]*,\d{2}\s*$", "", rest)
            details = re.sub(r"\s+\d[\d,]*\.\d{2}\s*$", "", details)
        details = re.sub(r"\s+", " ", details).strip()[:120] or "(unknown)"
        # infer year from the statement period
        yr = start_y
        try:
            if not (p_start <= _dt.date(start_y, mm, dd) <= p_end):
                yr = end_y
        except ValueError:
            pass
        date = f"{yr:04d}-{mm:02d}-{dd:02d}"
        # The credit/refund marker may be on this line OR the next 1-2 lines.
        is_credit = bool(CREDIT_MARKER_RE.search(details + " " + rest))
        for nl in lines[idx + 1 : idx + 3]:
            if _layout_a_row(nl):
                break  # next transaction row — stop looking ahead
            if CREDIT_MARKER_RE.search(nl):
                is_credit = True
                break
        rows.append({
            "Date": date,
            "Merchant": details,
            "Amount": amount if is_credit else -amount,
            "Currency": "EUR",
        })
    tot = (debits, credits) if (debits is not None and credits is not None) else None
    return rows, tot


# ───────────────────── American Express, layout B ─────────────────────
# Month-name dates ("Jan 5"), dot decimals, a "Statement Period" line and a
# currency symbol on the totals line.
_SYMBOL_CCY = {"£": "GBP", "$": "USD", "€": "EUR"}


def parse_amex_layout_b(text):
    lines = text.split("\n")
    # period: "Statement Period From <day><month> to <day><month><year>"
    pm = re.search(r"From\s*\d{1,2}\s*([A-Za-z]+)\s*to\s*\d{1,2}\s*([A-Za-z]+)\s*(\d{4})", text)
    if not pm:
        raise ValueError("'Statement Period From ... to ... YYYY' not found - cannot year-stamp rows")
    end_y = int(pm.group(3))
    start_mon = month_index(pm.group(1)) or 1
    end_mon = month_index(pm.group(2)) or 1
    start_y = end_y - 1 if start_mon > end_mon else end_y

    # totals: "<sym>200.00 - <sym>200.00 + <sym>0.00 = <sym>0.00" → prev, credits, debits, closing
    credits = debits = None
    s = r"([£$€])"
    tm = re.search(s + r"([\d,]+\.\d{2})\s*-\s*[£$€]([\d,]+\.\d{2})\s*\+\s*[£$€]([\d,]+\.\d{2})\s*=\s*[£$€]([\d,]+\.\d{2})", text)
    if tm:
        credits, debits = num(tm.group(3)), num(tm.group(4))
    # Rows print bare amounts; the currency is the symbol the statement uses.
    sm = tm or re.search(s + r"\s?[\d,]+\.\d{2}", text)
    if not sm:
        raise ValueError("no currency symbol found on the statement - cannot tell the currency")
    ccy = _SYMBOL_CCY[sm.group(1)]

    rows = []
    for idx, line in enumerate(lines):
        m = re.match(r"^\|?\s*([A-Z][a-z]{2})\s?(\d{1,2})\s+[A-Z][a-z]{2}\s?\d{1,2}\b(.*)$", line)
        if not m:
            continue
        mm = month_index(m.group(1))
        if not mm:
            continue
        dd = int(m.group(2))
        rest = m.group(3)
        amts = re.findall(r"([\d,]+\.\d{2})", rest)
        if not amts:
            continue
        amount = num(amts[-1])
        if amount is None or amount == 0:
            continue
        yr = start_y if mm >= start_mon else end_y
        # Merchant lives in the FIRST non-empty, non-amount pipe-cell of `rest`.
        # rest looks like "| EXAMPLE HOTELS LTD - TOWN |   |   | 250.00 |", so the
        # name is cell[1] not cell[0] (the leading "|" makes split()[0] an empty cell).
        segs = [s.strip() for s in rest.split("|")]
        segs = [s for s in segs if s and not re.fullmatch(r"[\d,]+\.\d{2}|CR", s, re.I)]
        details = segs[0] if segs else ""
        details = re.sub(r"[\d,]+\.\d{2}", "", details)
        details = re.sub(r"\s+", " ", details).strip(" |-")[:120] or "(unknown)"
        nxt = lines[idx + 1].strip().upper() if idx + 1 < len(lines) else ""
        is_credit = rest.upper().rstrip().endswith("CR") or nxt == "CR" or "PAYMENT RECEIVED" in rest.upper()
        rows.append({
            "Date": f"{yr:04d}-{mm:02d}-{dd:02d}",
            "Merchant": details,
            "Amount": amount if is_credit else -amount,
            "Currency": ccy,
        })
    tot = (debits, credits) if (debits is not None and credits is not None) else None
    return rows, tot


# ───────────────────────── Wise (tolerant) ─────────────────────────
_WISE_DATE = re.compile(r"(\d{1,2}\.?\s+(?:de\s+)?" + MONTH_WORD_RE + r"\s+(?:de\s+)?20\d{2})", re.I)


def parse_wise(text):
    lines = text.split("\n")
    cm = STATEMENT_HEADING_RE.search(text)
    ccy = cm.group(1).upper() if cm else "EUR"
    # The statement is rendered in the language active at download time. A
    # localised download prints "1.234,56" instead of "1,234.56"; reading it with
    # the dot-decimal pattern yields 0 rows, so detect the layout and switch.
    DATE = _WISE_DATE
    if DECIMAL_COMMA_MARKER_RE.search(text):
        AMT = re.compile(r"(-?\d[\d.]*,\d{2})(?!\d)")
    else:
        AMT = re.compile(r"(-?[\d,]+\.\d{2})")
    rows = []
    for idx, line in enumerate(lines):
        L = line.replace("|", " ")
        amts = AMT.findall(L)
        if len(amts) < 2:
            continue
        amount = num(amts[-2])   # txn amount (signed), last = running balance
        if amount is None or amount == 0:
            continue
        dt = None
        # A transaction prints its DESCRIPTION + amounts first and its date on the
        # NEXT line ("20 August 2026 | Transaction: TRANSFER-..."), and the
        # statement runs newest-first. Searching upwards would read the date line
        # of the transaction ABOVE — the previous, later-dated charge — so the same
        # charge gets two dates across re-exports and fails to dedup.
        # The date is BELOW the amount, never above - so start at idx.
        for j in range(idx, min(len(lines), idx + 5)):
            dm = DATE.search(lines[j].replace("|", " "))
            if dm:
                dt = dm.group(1)
                break
        if not dt:
            continue
        before = re.sub(r"\s+", " ", AMT.split(L)[0]).strip()
        if len(before) < 4:
            for j in range(idx - 1, max(0, idx - 5), -1):
                cand = re.sub(r"\s+", " ", lines[j].replace("|", " ")).strip()
                low = cand.lower()
                if cand and any(c.isalpha() for c in cand) and not DATE.search(cand) \
                   and not low.startswith(("transaction", "reference", "card ending", "ref:", "incoming", "description")):
                    before = cand
                    break
        # "Card transaction of 200.00 EUR issued by Example Store TOWN" (and its
        # localised twins) hold the real merchant AFTER the amount, so splitting on
        # the amount leaves every card payment named after the bare stem.
        # Search the FULL line first: when the amount sits on the same line, splitting
        # on it truncates the text right before the merchant part.
        # A refund prints a NEGATIVE face value ("Card transaction of -100.00 EUR issued by
        # Example Store ...", amount +100.00), hence the optional minus in the pattern.
        full = re.sub(r"\s+", " ", line.replace("|", " ")).strip()
        cm2 = re.search(CARD_TRANSACTION_RE, full, re.I) or re.search(CARD_TRANSACTION_RE, before, re.I)
        is_cash = False
        if cm2:
            before = cm2.group(3).strip()
            # A card row CHARGED more than the face value printed in its own description,
            # in the SAME currency, is a cash withdrawal — the gap is the ATM fee. A
            # real purchase charges exactly the face value and an FX purchase differs in
            # CURRENCY, not by a fee, so neither trips this. Without it the withdrawal
            # arrives named only after the ATM operator ("Example ATM Operator"), which
            # reads like a shop and can end up uncategorised or tagged as a transfer.
            # Example: 200.00 face value charged 205.00 (an ATM), vs a 5.00 subscription
            # charged 5.00 (no gap, correctly left alone).
            face = num(cm2.group(1))
            if face and cm2.group(2).upper() == (ccy or "").upper():
                delta = abs(amount) - face
                # Bounded: a withdrawal fee is a few percent. A larger gap is something
                # else and must not be silently relabelled as cash.
                if 0 < delta <= face * 0.10:
                    is_cash = True
        # a same-line hit drags the amount + running balance along behind the name
        # [\d.,]* not [\d.]*: a running balance with a comma thousands separator
        # ("-200.00 12,000.00") otherwise survives the strip and ends up glued onto the merchant.
        before = re.sub(r"\s+-?[\d.,]*[.,]\d{2}(\s+-?[\d.,]*[.,]\d{2})*\s*$", "", before).strip()
        desc = before[:120] or "(unknown)"
        if is_cash and "cash withdrawal" not in desc.lower():
            # "cash withdrawal" is an existing keyword in src/lib/categorise.ts -> Cash / ATM.
            desc = ("Cash withdrawal at " + desc)[:120]
        iso = to_iso(dt)
        if not iso:
            continue
        rows.append({"Date": iso, "Merchant": desc, "Amount": amount, "Currency": ccy})
    return rows, None


def parse_revolut_csv(path):
    """Revolut's native CSV export (business format, 'Date started (UTC)' header).

    Better source than the PDF→markdown statement: machine-written, and the
    Balance column lets the whole file be verified — replaying the rows
    oldest-first, each row must satisfy prev_balance + Total amount == Balance.
    Returns (rows, chain_ok) where chain_ok is True/False, or None when no
    balance data exists. Raises on an unknown header (e.g. the personal-app CSV
    format) so a wrong-format file fails LOUDLY instead of parsing as 0 rows.

    Dates: use "Date completed" — that is what the PDF statements and the
    hand-entered DB rows carry (started on the 29th, completed on the 30th → the 30th).
    Amount: "Total amount" (signed, net of the conversion fee).
    """
    import csv as _csv
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rdr = _csv.DictReader(fh)
        fields = rdr.fieldnames or []
        if "Date started (UTC)" not in fields or "Total amount" not in fields:
            raise ValueError(f"unknown Revolut CSV header: {fields[:6]}")
        raw = list(rdr)

    completed = []
    for r in raw:
        if (r.get("State") or "").strip().upper() != "COMPLETED":
            continue
        date = (r.get("Date completed (UTC)") or r.get("Date started (UTC)") or "").strip()[:10]
        if not re.match(r"\d{4}-\d{2}-\d{2}$", date):
            continue
        amount = num(r.get("Total amount") or "")
        if amount is None:
            continue
        ccy = (r.get("Payment currency") or "EUR").strip().upper() or "EUR"
        desc = re.sub(r"\s+", " ", (r.get("Description") or "").strip())
        ref = re.sub(r"\s+", " ", (r.get("Reference") or "").strip())
        merch = f"{desc} • {ref}" if desc and ref else (desc or ref or "(unknown)")
        completed.append({
            "Date": date, "Merchant": merch[:140], "Amount": amount, "Currency": ccy,
            "_bal": num(r.get("Balance") or ""),
            "_pocket": f"{(r.get('Account') or '').strip()}|{ccy}",
        })
    if raw and not completed:
        # Rows exist but none was usable: the State or date column changed shape.
        # Loud, never a quiet "0 txns | (no balance data)".
        raise ValueError(f"{len(raw)} rows but none COMPLETED with a YYYY-MM-DD date - export format changed?")

    # Balance-chain check per pocket (Account+currency). Export order is
    # newest-first, so walking the list forward: bal[i] - amount[i] == bal[i+1].
    chain_ok = None
    by_pocket = {}
    for row in completed:
        by_pocket.setdefault(row["_pocket"], []).append(row)
    for seq in by_pocket.values():
        if any(r["_bal"] is None for r in seq):
            continue
        for newer, older in zip(seq, seq[1:]):
            if chain_ok is None:
                chain_ok = True
            if abs((newer["_bal"] - newer["Amount"]) - older["_bal"]) > 0.005:
                chain_ok = False

    rows = []
    for r in completed:
        if r["Amount"] == 0:
            continue  # zero-value rows exist only for the balance chain
        rows.append({"Date": r["Date"], "Merchant": r["Merchant"],
                     "Amount": r["Amount"], "Currency": r["Currency"]})
    return rows, chain_ok


def parse_wise_csv(path):
    """Wise's native CSV export (one file per currency pocket, newest-first).

    Header: "TransferWise ID", Date, "Date Time", Amount, Currency, Description,
    "Payment Reference", "Running Balance", ..., Merchant, ..., "Total fees", ...,
    "Transaction Type", "Transaction Details Type".  A pocket with no activity
    exports as a header-only file — that is a legitimate 0, reported as such.

    Returns (rows, chain_ok) like parse_revolut_csv. Raises on an unknown header
    so a wrong-format file fails LOUDLY instead of parsing as 0 rows.

    Why this exists: the PDF path has to INFER the date's position on the page.
    The CSV prints the date in a column and a Running Balance that lets every
    row be replayed — the same machine-written guarantee the Revolut CSV gives.

    Shape rules, chosen so the PDF and the CSV of the same account dedup against
    each other:
      * FEE IS INSIDE Amount. A transfer with "Total fees 5.00" exports as ONE row
        Amount -1000.00 and the balance moves by exactly 1000.00. The PDF prints
        TWO lines: principal "-995.00 ... (fee: 5.00 EUR)" and "-5.00 Wise Charges
        for: TRANSFER-<id>". Split the same way, or the principal never matches
        its PDF twin and imports twice.
      * CARD rows keep the fee folded in (the PDF folds it too) and carry the
        clean `Merchant` column; a card row charged more than the face value in
        its own Description, same currency, by <=10 %, is a cash withdrawal —
        identical heuristic to parse_wise so the label matches.
      * Date is the CSV `Date` column (DD-MM-YYYY).
    """
    import csv as _csv
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rdr = _csv.DictReader(fh)
        fields = rdr.fieldnames or []
        need = ("TransferWise ID", "Date", "Amount", "Currency", "Description", "Running Balance")
        if any(f not in fields for f in need):
            raise ValueError(f"unknown Wise CSV header: {fields[:6]}")
        raw = list(rdr)
    if not raw:
        return [], None

    CARD_RE = re.compile(r"Card transaction of\s+(-?[\d.,]+)\s*([A-Z]{3})\s+issued by\s+(.+)$", re.I)
    kept = []
    for r in raw:
        d = (r.get("Date") or "").strip()
        m = re.match(r"(\d{2})-(\d{2})-(\d{4})$", d)
        if not m:
            continue
        date = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        amount = num(r.get("Amount") or "")
        if amount is None:
            continue
        ccy = (r.get("Currency") or "EUR").strip().upper() or "EUR"
        desc = re.sub(r"\s+", " ", (r.get("Description") or "").strip())
        fee = num(r.get("Total fees") or "") or 0.0
        dtype = (r.get("Transaction Details Type") or "").strip().upper()
        merch = desc or "(unknown)"

        if dtype == "CARD":
            col = re.sub(r"\s+", " ", (r.get("Merchant") or "").strip())
            cm = CARD_RE.search(desc)
            merch = col or (cm.group(3).strip() if cm else desc)
            if cm:
                face = num(cm.group(1))
                if face and cm.group(2).upper() == ccy:
                    delta = abs(amount) - face
                    if 0 < delta <= face * 0.10 and "cash withdrawal" not in merch.lower():
                        merch = "Cash withdrawal at " + merch
            fee = 0.0                              # folded in, like the PDF

        kept.append({"Date": date, "Merchant": merch[:120], "Amount": amount,
                     "Currency": ccy, "_bal": num(r.get("Running Balance") or ""),
                     "_fee": fee, "_id": (r.get("TransferWise ID") or "").strip()})

    if not kept:
        # `raw` is non-empty here (a header-only pocket returned above), so every
        # row failed the DD-MM-YYYY / Amount parse. Reporting that as "(empty
        # pocket)" would hand a file full of rows the one label the importer treats
        # as legitimate.
        raise ValueError(f"{len(raw)} rows but none matched Date DD-MM-YYYY + Amount - export format changed?")

    # Balance chain, newest-first: bal[i] - Amount[i] == bal[i+1]. The ORIGINAL
    # amount (fee included) is what moved the balance.
    chain_ok = None
    if all(r["_bal"] is not None for r in kept):
        for newer, older in zip(kept, kept[1:]):
            if chain_ok is None:
                chain_ok = True
            if abs((newer["_bal"] - newer["Amount"]) - older["_bal"]) > 0.005:
                chain_ok = False

    rows = []
    for r in kept:
        amt, fee = r["Amount"], r["_fee"]
        if fee > 0 and amt < 0:
            principal = round(amt + fee, 2)              # -1000.00 + 5.00 = -995.00
            if principal != 0:
                rows.append({"Date": r["Date"], "Currency": r["Currency"], "Amount": principal,
                             "Merchant": f"{r['Merchant']} (fee: {fee:.2f} {r['Currency']})"[:120]})
            rows.append({"Date": r["Date"], "Currency": r["Currency"], "Amount": -round(fee, 2),
                         "Merchant": f"Wise Charges for: {r['_id']}"[:120]})
            continue
        if amt == 0:
            continue
        rows.append({"Date": r["Date"], "Merchant": r["Merchant"],
                     "Amount": amt, "Currency": r["Currency"]})
    return rows, chain_ok


# ── Positioned-text PDFs: reconstruct visual lines by clustering words on the
#    same y-coordinate. Used for bank detection when markitdown finds no text layer
#    worth reading. ────────────────────────────────────────────────────────────
def reconstruct_pdf_lines(path):
    import pdfplumber
    out = []
    with pdfplumber.open(path) as pdf:
        for p in pdf.pages:
            rows = {}
            for w in p.extract_words():
                rows.setdefault(round(w["top"] / 3) * 3, []).append((w["x0"], w["text"]))
            for k in sorted(rows):
                out.append(" ".join(t for _, t in sorted(rows[k])))
    return out
