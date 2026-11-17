"""Statement parsing + reconciliation, against synthetic fixtures with KNOWN totals.

The point of these is the second test in each pair: a reconciliation that cannot
fail is not a check, so the sabotaged file must be caught, every time.
"""
import pytest

import parse_statements as P
from conftest import fixture_path
from l10n_keywords import (
    ACCOUNT_HOLDER,
    CARD_TRANSACTION,
    CREDIT_MARKERS,
    MONTH_NAMES,
    PERIOD_WORDS,
    STATEMENT_WORD,
    SUMMARY_WORDS,
    month_index,
)


# ───────────────────────── number + date primitives ─────────────────────────
def test_num_reads_comma_and_dot_decimals():
    assert P.num("1.908,50") == 1908.5       # dot thousands, comma decimal
    assert P.num("1,908.50") == 1908.5       # comma thousands, dot decimal
    assert P.num("-3.000,00") == -3000.0
    assert P.num("23 000.00") == 23000.0     # space thousands separator
    assert P.num("12,5") == 12.5
    assert P.num("n/a") is None


def test_to_iso_reads_day_first_and_month_first_forms():
    assert P.to_iso("12 Feb 2026") == "2026-02-12"
    assert P.to_iso("12 Sept 2026") == "2026-09-12"   # four-letter abbreviation
    assert P.to_iso("Jun 6, 2026") == "2026-06-06"    # month first, comma after the day
    assert P.to_iso("not a date") is None


@pytest.mark.parametrize("lang", sorted(MONTH_NAMES))
def test_to_iso_reads_every_month_in_every_table_language(lang):
    for idx, name in enumerate(MONTH_NAMES[lang], 1):
        assert month_index(name) == idx
        assert P.to_iso(f"27. {name.title()} 2026") == f"2026-{idx:02d}-27"
        assert P.to_iso(f"3 {name} 2026") == f"2026-{idx:02d}-03"


# ───────────────────────────── Revolut ─────────────────────────────
def test_revolut_pdf_reads_four_letter_sept():
    # September can be printed "Sept"; a 3-letter-only date pattern would parse
    # the whole statement as 0 rows.
    text = (
        "| 18 Sept 2026 | CAR | Example Fuel 0001 | €20.00 |     | €10.00 |\n"
        "12 Sept 2026 FEE Revolut Business Fee • Basic plan fee €10.00 -€5.00\n"
        "15 Sept 2026 MOA Money added from ALICE EXAMPLE  €100.00 €96.00\n"
        "| 26 Aug 2026 | CAR | Example Web Shop | €1 200.00 |          | €400.00 |\n"
    )
    rows, _ = P.parse_revolut(text)
    got = [(r["Date"], r["Amount"]) for r in rows]
    assert got == [("2026-09-18", -20.0), ("2026-09-12", -10.0),
                   ("2026-09-15", 100.0), ("2026-08-26", -1200.0)]


def test_revolut_csv_rows_totals_and_clean_balance_chain():
    rows, chain_ok = P.parse_revolut_csv(fixture_path("revolut_ok.csv"))
    assert len(rows) == 10
    assert round(sum(-r["Amount"] for r in rows if r["Amount"] < 0), 2) == 365.5
    assert round(sum(r["Amount"] for r in rows if r["Amount"] > 0), 2) == 4803.0
    assert chain_ok is True


def test_revolut_csv_sabotaged_balance_is_caught():
    """Identical rows and totals to revolut_ok.csv — one running balance is off by
    EUR 10. Totals alone would pass it; only the balance chain can see it."""
    rows, chain_ok = P.parse_revolut_csv(fixture_path("revolut_broken.csv"))
    assert len(rows) == 10
    assert round(sum(-r["Amount"] for r in rows if r["Amount"] < 0), 2) == 365.5
    assert chain_ok is False


def test_revolut_csv_unknown_header_raises_instead_of_returning_nothing(tmp_path):
    p = tmp_path / "personal-app.csv"
    p.write_text("Type,Product,Started Date,Amount\nCARD,Current,2026-07-01,-5.00\n", encoding="utf-8")
    try:
        P.parse_revolut_csv(str(p))
    except ValueError as e:
        assert "header" in str(e).lower()
    else:
        raise AssertionError("an unknown Revolut header must raise, not parse 0 rows")


# ───────────────────────────── Wise PDF text ─────────────────────────────
WISE_EN = """Wise Europe SA
EUR statement
Description Incoming Outgoing Amount
Sent money to Example Ltd | -3,000.00 | 1,250.50
27 July 2026 | Transaction: TRANSFER-1
Card transaction of 300.00 EUR issued by Example ATM Operator | -308.00 | 4,250.50
20 July 2026 | Transaction: CARD-2
"""


def _wise_localised(lang: str) -> str:
    """A decimal-comma download in one table language, built from the table."""
    lead, issued_by = CARD_TRANSACTION[lang]
    july = MONTH_NAMES[lang][6]
    return (
        "Wise Europe SA\n"
        f"EUR-{STATEMENT_WORD[lang].title()}\n"
        f"{ACCOUNT_HOLDER[lang].title()} Test Person\n"
        "Transfer Example Company | -3.000,00 | 1.250,50\n"
        f"27 {july} 2026 | TRANSFER-1\n"
        f"{lead.capitalize()} 5,00 EUR {issued_by} Example Music | -5,00 | 4.250,50\n"
        f"20 {july} 2026 | CARD-2\n"
    )


@pytest.mark.parametrize("lang", sorted(ACCOUNT_HOLDER))
def test_wise_localised_download_is_not_an_empty_month(lang):
    rows, _ = P.parse_wise(_wise_localised(lang))
    assert [(r["Date"], r["Amount"]) for r in rows] == [
        ("2026-07-27", -3000.0), ("2026-07-20", -5.0)]
    assert rows[1]["Merchant"].startswith("Example Music")


def test_wise_date_comes_from_the_line_below_and_atm_gap_means_cash():
    rows, _ = P.parse_wise(WISE_EN)
    assert [r["Date"] for r in rows] == ["2026-07-27", "2026-07-20"]
    # 300.00 face, 308.00 charged, same currency -> an ATM fee, so it is cash
    assert rows[1]["Merchant"].lower().startswith("cash withdrawal at")


# ───────────────────────── American Express layouts ─────────────────────────
@pytest.mark.parametrize("lang", sorted(PERIOD_WORDS))
def test_amex_layout_a_rows_credits_and_totals(lang):
    start, end = PERIOD_WORDS[lang]
    credits, debits = SUMMARY_WORDS[lang]
    credit_marker = CREDIT_MARKERS[lang][0].upper()
    text = (
        f"American Express\n{start} 20.12.25 {end} 19.01.26\n"
        f"Saldo {credits.title()} {debits.title()} Saldo\n"
        "100,00 50,00 1.262,50 1.312,50\n"
        "| 22.12 | 23.12 | EXAMPLE STORE TOWN | 62,50 |\n"
        "05.01 06.01 EXAMPLE AIRLINE 1.200,00\n"
        f"| 10.01 | 11.01 | EXAMPLE STORE TOWN {credit_marker} | 50,00 |\n"
    )
    rows, totals = P.parse_amex_layout_a(text)
    assert [(r["Date"], r["Amount"], r["Currency"]) for r in rows] == [
        ("2025-12-22", -62.5, "EUR"), ("2026-01-05", -1200.0, "EUR"), ("2026-01-10", 50.0, "EUR")]
    assert rows[1]["Merchant"] == "EXAMPLE AIRLINE"
    assert totals == (1262.5, 50.0)


def test_amex_layout_a_without_a_billing_period_raises():
    with pytest.raises(ValueError, match="billing period"):
        P.parse_amex_layout_a("American Express\n| 22.12 | 23.12 | EXAMPLE STORE | 62,50 |\n")


@pytest.mark.parametrize("symbol,ccy", [("$", "USD"), ("£", "GBP"), ("€", "EUR")])
def test_amex_layout_b_rows_credits_and_totals(symbol, ccy):
    s = symbol
    text = (
        "American Express\nStatement Period From 20December to19January2026\n"
        f"{s}200.00 - {s}200.00 + {s}300.00 = {s}300.00\n"
        "| Dec 22 Dec 23 | EXAMPLE HOTELS LTD - TOWN |   |   | 250.00 |\n"
        "| Jan 5 Jan 6 | EXAMPLE STORE |   |   | 50.00 |\n"
        "| Jan 10 Jan 11 | PAYMENT RECEIVED - THANK YOU |   |   | 200.00 |\n"
    )
    rows, totals = P.parse_amex_layout_b(text)
    assert [(r["Date"], r["Amount"], r["Currency"]) for r in rows] == [
        ("2025-12-22", -250.0, ccy), ("2026-01-05", -50.0, ccy), ("2026-01-10", 200.0, ccy)]
    assert rows[0]["Merchant"] == "EXAMPLE HOTELS LTD - TOWN"
    assert totals == (300.0, 200.0)


def test_amex_layout_b_without_a_currency_symbol_raises():
    text = ("Statement Period From 20December to19January2026\n"
            "| Jan 5 Jan 6 | EXAMPLE STORE |   |   | 50.00 |\n")
    with pytest.raises(ValueError, match="currency symbol"):
        P.parse_amex_layout_b(text)
