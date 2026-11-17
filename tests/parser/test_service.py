"""The HTTP layer: Trading 212 conventions, upload safety, /health, and the
end-to-end /parse verdicts the import dialog relies on."""
import io
import zipfile

import statement_service as S
from conftest import fixture_path

T212_HEADER = "Action,Time,Ticker,No. of shares,Price / share,Currency (Total),Total,Result\n"


def t212(*lines: str) -> str:
    return T212_HEADER + "\n".join(lines) + "\n"


# ───────────────────────── Trading 212 conventions ─────────────────────────
def test_trading212_fixture_conventions():
    with open(fixture_path("trading212.csv"), encoding="utf-8") as fh:
        rows = S.parse_trading212_csv(fh.read())
    by = {r["Merchant"].split(" (")[0]: r for r in rows}
    assert by["Deposit"]["Category"] == "transfers" and by["Deposit"]["Amount"] > 0
    assert by["Market buy EXA"]["Category"] == "transfers" and by["Market buy EXA"]["Amount"] < 0
    assert by["Market sell EXA"]["Category"] == "transfers" and by["Market sell EXA"]["Amount"] > 0
    assert by["Interest on cash"]["Category"] == "other-income"
    assert by["Card debit"]["Category"] == "fees" and by["Card debit"]["Amount"] < 0
    assert by["Withdrawal"]["Amount"] < 0
    # realised P/L rides on the label, so it can be parsed back out
    assert any("(realised 100.00)" in r["Merchant"] for r in rows)


def test_stop_and_limit_orders_are_position_changes_not_dropped_rows():
    unknown: list[str] = []
    rows = S.parse_trading212_csv(t212(
        "Stop sell,2026-08-19 15:00:00,EXB,5,300.00,EUR,1500.00,-30.00",
        "Stop limit sell,2026-08-20 15:00:00,EXA,3,150.00,EUR,450.00,12.00",
        "Limit sell,2026-08-21 15:00:00,EXC,2,200.00,EUR,400.00,5.00",
        "Limit buy,2026-08-22 15:00:00,EXC,2,190.00,EUR,380.00,",
        "Stop buy,2026-08-23 15:00:00,EXA,1,155.00,EUR,155.00,",
    ), unknown)
    assert unknown == []
    assert [(r["Merchant"].split(" (")[0], r["Amount"], r["Category"]) for r in rows] == [
        ("Market sell EXB", 1500.0, "transfers"),
        ("Market sell EXA", 450.0, "transfers"),
        ("Market sell EXC", 400.0, "transfers"),
        ("Market buy EXC", -380.0, "transfers"),
        ("Market buy EXA", -155.0, "transfers"),
    ]
    assert "(realised -30.00)" in rows[0]["Merchant"]


def test_dividends_are_income():
    rows = S.parse_trading212_csv(t212(
        "Dividend (Ordinary),2026-08-15 10:00:00,EXB,5,1.00,EUR,5.00,",
        "Dividend (Dividend),2026-08-16 10:00:00,EXC,2,0.50,EUR,1.00,",
    ))
    assert [(r["Merchant"], r["Amount"], r["Category"]) for r in rows] == [
        ("Dividend EXB", 5.0, "other-income"), ("Dividend EXC", 1.0, "other-income")]


def test_time_utc_header_and_new_card_cost():
    # Newer exports name the date column `Time (UTC)`, and a `New card cost` fee can appear.
    text = ("Action,Time (UTC),Ticker,Currency (Total),Total,Result\n"
            "Interest on cash,2026-09-03 01:15:48+00:00,,EUR,0.01,\n"
            "New card cost,2026-09-29 08:22:13+00:00,,EUR,-4.95,\n")
    unknown = []
    rows = S.parse_trading212_csv(text, unknown)
    assert [(r["Date"], r["Merchant"], r["Amount"], r["Category"]) for r in rows] == [
        ("2026-09-03", "Interest on cash", 0.01, "other-income"),
        ("2026-09-29", "New card cost", -4.95, "fees")]
    assert unknown == []


def test_unreadable_date_is_reported_not_skipped():
    unknown = []
    rows = S.parse_trading212_csv("Action,When,Currency (Total),Total\nDeposit,yesterday,EUR,100\n", unknown)
    assert rows == [] and len(unknown) == 1


def test_unknown_action_is_reported_never_silently_dropped():
    unknown: list[str] = []
    rows = S.parse_trading212_csv(t212(
        "Deposit,2026-08-01 10:00:00,,,,EUR,100.00,",
        "Stock split,2026-08-02 10:00:00,EXA,,,EUR,42.00,",
    ), unknown)
    assert len(rows) == 1
    assert len(unknown) == 1 and "Stock split" in unknown[0] and "42.0" in unknown[0]


def test_parse_endpoint_surfaces_unknown_actions_in_the_verdict(client):
    body = t212(
        "Deposit,2026-08-01 10:00:00,,,,EUR,100.00,",
        "Stock split,2026-08-02 10:00:00,EXA,,,EUR,42.00,",
    )
    r = client.post("/parse", files={"file": ("t212.csv", body, "text/csv")})
    assert r.status_code == 200
    d = r.json()
    # Accounts are user-created, so the parser never guesses one: the dialog asks.
    assert d["format"] == "trading212_csv" and d["account"] is None
    assert len(d["rows"]) == 1
    assert "UNKNOWN ACTION" in d["validation"]["detail"]
    assert d["validation"]["unknownActions"] and "Stock split" in d["validation"]["unknownActions"][0]
    assert any("NOT imported" in w for w in d["warnings"])


# ───────────────────────────── /parse end to end ─────────────────────────────
def _post_fixture(client, name):
    with open(fixture_path(name), "rb") as fh:
        return client.post("/parse", files={"file": (name, fh.read(), "text/csv")})


def test_parse_revolut_ok(client):
    d = _post_fixture(client, "revolut_ok.csv").json()
    assert d["format"] == "revolut_csv" and len(d["rows"]) == 10
    assert d["validation"]["ok"] is True
    assert (d["validation"]["out"], d["validation"]["in"]) == (365.5, 4803.0)
    assert "balance-chain OK" in d["validation"]["detail"]


def test_parse_revolut_sabotage_is_caught(client):
    d = _post_fixture(client, "revolut_broken.csv").json()
    assert d["validation"]["ok"] is False
    assert "BALANCE-CHAIN MISMATCH" in d["validation"]["detail"]


def test_bom_prefixed_upload_still_detected(client):
    with open(fixture_path("revolut_ok.csv"), "rb") as fh:
        data = b"\xef\xbb\xbf" + fh.read()
    d = client.post("/parse", files={"file": ("bom.csv", data, "text/csv")}).json()
    assert d["format"] == "revolut_csv" and len(d["rows"]) == 10


def test_unrecognised_csv_falls_back_instead_of_guessing(client):
    r = client.post("/parse", files={"file": ("x.csv", "Date,Description,Amount\n2026-01-01,a,1\n", "text/csv")})
    assert r.json()["fallback"] == "generic-csv"


def test_empty_upload_is_400(client):
    assert client.post("/parse", files={"file": ("x.csv", b"", "text/csv")}).status_code == 400


# ───────────────────────────── upload safety ─────────────────────────────
def test_strip_bom_handles_a_pdf_with_a_utf8_bom():
    assert S.strip_bom(b"\xef\xbb\xbf%PDF-1.7") == b"%PDF-1.7"
    assert S.strip_bom(b"%PDF-1.7") == b"%PDF-1.7"


def _zip(name: str, payload: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(name, payload)
    return buf.getvalue()


def test_unwrap_zip_returns_the_statement_inside():
    inner = S.unwrap_zip(_zip("statement.csv", b"a,b\n1,2\n"))
    assert inner == (b"a,b\n1,2\n", "statement.csv")


def test_zip_bomb_is_refused_before_it_is_inflated(monkeypatch):
    # Small cap so the test does not need a real 25 MB payload: what matters is that
    # the DECLARED uncompressed size is checked, because the upload cap only ever
    # sees the compressed bytes.
    monkeypatch.setattr(S, "MAX_BYTES", 1024)
    bomb = _zip("statement.csv", b"0" * 200_000)
    assert len(bomb) < 1024            # passes the upload-size check…
    assert S.unwrap_zip(bomb) is None  # …and is still refused


def test_zip_bomb_via_the_endpoint_is_422(client, monkeypatch):
    monkeypatch.setattr(S, "MAX_BYTES", 1024)
    r = client.post("/parse", files={"file": ("s.zip", _zip("statement.csv", b"0" * 200_000), "application/zip")})
    assert r.status_code == 422


# ───────────────────────────── /health + engine ─────────────────────────────
def test_health_stays_ok_when_ollama_is_down(client, monkeypatch):
    monkeypatch.setattr(S, "OLLAMA_URL", "http://127.0.0.1:9")   # discard port: refused
    d = client.get("/health").json()
    assert d == {"ok": True, "engine": S.RECEIPT_ENGINE, "ollamaUp": False}


def test_health_leaks_no_urls_models_or_key_state(client, monkeypatch):
    monkeypatch.setattr(S, "ollama_up", lambda: True)
    assert set(client.get("/health").json()) == {"ok", "engine", "ollamaUp"}


def test_receipt_engine_cannot_be_overridden_per_request(client, monkeypatch):
    """A form field used to pick the engine, so any local process could send a
    receipt to OpenRouter. Only the environment decides now."""
    called: list[str] = []

    async def fake_ollama(data):
        called.append("ollama")
        raise S.EngineError("stop here", 503, "test")

    async def fake_openrouter(data):
        called.append("openrouter")
        raise S.EngineError("stop here", 503, "test")

    monkeypatch.setattr(S, "RECEIPT_ENGINE", "ollama")
    monkeypatch.setattr(S, "read_via_ollama", fake_ollama)
    monkeypatch.setattr(S, "read_via_openrouter", fake_openrouter)
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
    client.post("/receipt", files={"file": ("r.png", png, "image/png")}, data={"engine": "openrouter"})
    assert called == ["ollama"]


# ───────────────────────── F3 split prefill: pass-2 lines ─────────────────────────
def test_clean_lines_parses_string_amounts_and_drops_unreadable_lines():
    out = S.clean_lines([
        {"label": "Milk 1L", "amount": "1,20", "currency": "eur"},
        {"label": "Bread", "amount": 2.3, "currency": "EUR"},
        {"label": "Discount", "amount": -0.5, "currency": None},
        {"label": "", "amount": 9.99},
        {"label": "No amount", "amount": None},
        {"label": "Garbage", "amount": "n/a"},
    ])
    assert [l["label"] for l in out] == ["Milk 1L", "Bread", "Discount"]
    assert [l["amount"] for l in out] == [1.2, 2.3, -0.5]
    assert out[0]["currency"] == "EUR" and out[2]["currency"] is None


def test_clean_lines_empty_input():
    assert S.clean_lines([]) == []
    assert S.clean_lines(None) == []


# ───────────────────────── upload gate + secrets + render cap ─────────────────────────
def test_oversized_content_length_is_refused_before_the_body_is_read(client):
    r = client.post("/parse", content=b"x", headers={
        "content-length": str(S.MAX_BYTES + S.MULTIPART_OVERHEAD + 1),
        "content-type": "multipart/form-data; boundary=x"})
    assert r.status_code == 413


def test_upload_without_content_length_is_refused(client):
    def chunks():
        yield b"--x\r\n"
    r = client.post("/parse", content=chunks(), headers={"content-type": "multipart/form-data; boundary=x"})
    assert r.status_code == 411


def test_placeholder_or_short_parser_token_fails_closed(client, monkeypatch):
    for weak in ("", "short-token", "change-me-parser-token", "x" * 20 + "placeholder"):
        monkeypatch.setattr(S, "PARSER_TOKEN", weak)
        r = client.post("/parse", files={"file": ("a.csv", b"a,b\n", "text/csv")},
                        headers={"X-Parser-Token": weak})
        assert r.status_code == 503, weak


def test_receipt_render_dpi_is_capped_for_huge_pages():
    assert S.receipt_render_dpi(595, 842) == S.RECEIPT_DPI          # A4 renders at full dpi
    huge = S.receipt_render_dpi(14400, 14400)                       # 200 in x 200 in MediaBox
    assert huge < S.RECEIPT_DPI
    assert (14400 / 72 * huge) * (14400 / 72 * huge) <= S.MAX_RENDER_PIXELS * 1.0001


def test_pil_decompression_bomb_guard_is_set():
    from PIL import Image
    assert Image.MAX_IMAGE_PIXELS == S.MAX_RENDER_PIXELS * 2


# ───────────────────────── payable-line choice (pass 2) ─────────────────────────
def test_choose_payable_prefers_part_payment_over_totals():
    picked = S.choose_payable([
        {"label": "Subtotal", "amount": 800.0, "currency": "EUR"},
        {"label": "VAT", "amount": 200.0, "currency": "EUR"},
        {"label": "Invoice total", "amount": 1000.0, "currency": "EUR"},
        {"label": "Grand total", "amount": 1000.0, "currency": "EUR"},
        {"label": "Amount due now (deposit)", "amount": 250.0, "currency": "EUR"},
    ])
    assert picked["amount"] == 250.0 and picked["rule"] == "due_now"


def test_payable_label_tables_cover_every_language_consistently():
    from l10n_keywords import NEVER_PAYABLE_LABELS, PAYABLE_LABELS

    langs = set(PAYABLE_LABELS[0][1])
    assert len(langs) >= 5
    for _name, by_lang in PAYABLE_LABELS:
        assert set(by_lang) == langs
    for by_lang in NEVER_PAYABLE_LABELS.values():
        assert set(by_lang) == langs


def test_a_bare_deposit_item_is_not_the_payable_line():
    picked = S.choose_payable([
        {"label": "Security deposit", "amount": 500.0, "currency": "EUR"},
        {"label": "Total", "amount": 750.0, "currency": "EUR"},
    ])
    assert picked["amount"] == 750.0 and picked["rule"] == "total"
