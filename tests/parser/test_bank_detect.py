"""Bank detection reads the ISSUER from the masthead — a bank named in the body
is a payee. Each case below is a misdetection the masthead rule prevents."""
import pytest

from bank_detect import MASTHEAD, detect_csv, detect_csv_text, detect_text
from l10n_keywords import PERIOD_WORDS, SUMMARY_WORDS

FILLER = "Account holder Test Person, 1 Example Street, 12345 Example City. " * 8
# Layout A in one of the table languages: the credits/debits summary header.
_CREDITS, _DEBITS = SUMMARY_WORDS["fr"]
AMEX_A = f"American Express\n{_CREDITS.title()} {_DEBITS.title()} Solde\n"


def test_masthead_is_300():
    # 300 sits between where a genuine issuer name lands and where the earliest
    # payee trap starts. Changing it needs the measurement redone, not a guess.
    assert MASTHEAD == 300


def test_issuer_in_the_masthead_wins():
    assert detect_text("Wise Europe SA\nEUR statement\n" + FILLER) == "wise"
    assert detect_text(AMEX_A + FILLER) == "amex_layout_a"


@pytest.mark.parametrize("lang", sorted(SUMMARY_WORDS))
def test_layout_a_is_recognised_in_every_table_language(lang):
    credits, debits = SUMMARY_WORDS[lang]
    assert detect_text(f"American Express\n{credits} {debits}\n" + FILLER) == "amex_layout_a"
    start, end = PERIOD_WORDS[lang]
    period = f"American Express\n{start} 01.07.26 {end} 31.07.26\n"
    assert detect_text(period + FILLER) == "amex_layout_a"


def test_layout_b_is_recognised_from_its_period_line():
    text = "American Express\nStatement Period From 20 June to 19 July 2026\n" + FILLER
    assert detect_text(text) == "amex_layout_b"


def test_a_payee_outside_the_masthead_does_not_claim_the_file():
    body = AMEX_A + FILLER
    assert len(body) > MASTHEAD
    text = body + "\nTransfer to Wise Europe SA, wise.com, TransferWise\n" * 9
    assert detect_text(text) == "amex_layout_a"


def test_paid_to_another_bank_inside_a_wise_statement_stays_wise():
    body = "Wise Europe SA\nEUR statement\n" + FILLER
    assert len(body) > MASTHEAD
    assert detect_text(body + "\nPaid to Example Bank | -400.00 | 1,000.00\n") == "wise"


def test_amex_payee_inside_wise_is_not_amex():
    body = "Wise Europe SA\nEUR statement\n" + FILLER
    start, end = PERIOD_WORDS["es"]
    text = body + f"\nSent money to AMERICAN EXPRESS {start} 01.07.26 {end} 31.07.26\n"
    assert detect_text(text) == "wise"


def test_revolut_gets_the_wide_window_but_runs_last():
    business = "Account statement\nExample Advisory Limited\n" + FILLER + "\nRevolut Bank UAB\n"
    assert detect_text(business) == "revolut_md"
    # …and a Revolut direct debit inside another issuer's statement must not claim it
    assert detect_text(AMEX_A + FILLER + "\nDirect debit Revolut\n") == "amex_layout_a"


def test_unknown_document_is_none_not_a_guess():
    assert detect_text("Invoice 123\nTotal 45.00 EUR\n") is None


def test_csv_headers():
    assert detect_csv("Date started (UTC),Date completed (UTC),State,Total amount,Balance") == "revolut_csv"
    assert detect_csv("Action,Time,Ticker,No. of shares,Total,Result") == "trading212_csv"
    assert detect_csv("TransferWise ID,Date,Amount,Running Balance") == "wise_csv"
    assert detect_csv("Date,Description,Amount") is None


def test_metadata_rows_before_the_header_are_skipped():
    text = "\n" + "\n".join(f'"META {i}","x"' for i in range(14)) + \
           "\nAction,Time,Ticker,No. of shares,Total,Result\nDeposit,2026-07-01 10:00:00,,,100.00,\n"
    assert detect_csv_text(text) == "trading212_csv"
