"""Bank/statement-format detection for the parser sidecar.

A browser upload has no folder or file-name convention to go by, so the bank is
read out of the file itself. Every fingerprint below is a string the
corresponding parser already depends on. Keeping them in one module means the
upload route and the tests identify a file the same way.
"""

import re

from l10n_keywords import (
    PERIOD_RE,
    STATEMENT_HEADING_RE,
    SUMMARY_WORDS,
    has_activity_headers,
)

# How much of a statement counts as its letterhead. Genuine issuer names land in
# the first ~120 characters; a payee "trap" (another bank named as a transfer
# counterparty) sits further down — so 300 separates them with margin.
MASTHEAD = 300


def detect_csv_text(text: str) -> str | None:
    """`detect_csv` over the first 40 non-empty lines, for exports that print
    metadata rows before the table header."""
    for line in [l for l in text.splitlines() if l.strip()][:40]:
        fmt = detect_csv(line)
        if fmt:
            return fmt
    return None


def detect_csv(header: str) -> str | None:
    h = header.lower()
    if "date started (utc)" in h and "total amount" in h:
        return "revolut_csv"
    if "action" in h and "ticker" in h and ("total" in h or "result" in h):
        return "trading212_csv"
    if "transferwise id" in h and "running balance" in h:
        return "wise_csv"
    return None


def _issuer_in(window: str, t: str, low: str) -> str | None:
    """Which bank's letterhead is this?

    `window` is the region searched for the ISSUER's own name. `t`/`low` stay
    whole-document, because the sub-checks below pick between two statement
    LAYOUTS of an issuer already identified (billing period, summary layout) —
    those markers legitimately sit deep in the file.
    """
    if "american express" in window or "americanexpress." in window:
        # Layout A: numeric DD.MM dates and decimal commas, with a localised
        # billing-period line or credits/debits summary (see l10n_keywords.py).
        if PERIOD_RE.search(t) or any(c in low and d in low for c, d in SUMMARY_WORDS.values()):
            return "amex_layout_a"
        # Activity export: no billing period and no summary — column headers only.
        if has_activity_headers(low):
            return "amex_layout_a"
        # Layout B: month-name dates and a "Statement Period" line.
        if "statement period" in low or re.search(r"[£$€]\s?[\d,]+\.\d{2}", t):
            return "amex_layout_b"

    if "wise europe" in window or "wise.com" in window or "transferwise" in window:
        return "wise"

    return None


def detect_text(text: str) -> str | None:
    """Identify a statement from its extracted text.

    Matches on the ISSUER, read from the document's own letterhead — never on a
    bank name appearing anywhere in the file. A payee is a bank name in someone
    else's statement: a bank statement can name "Wise" many times as a transfer
    counterparty, and a bare `"wise" in text` fingerprint would claim it as a Wise
    statement, parse 0 rows and report the wrong bank. Same trap with "AMEX" on a
    card-repayment line. Hence MASTHEAD.
    """
    t = text[:20000]
    low = t.lower()
    masthead = t[:MASTHEAD].lower()
    head = t[:4000].lower()

    fmt = _issuer_in(masthead, t, low)
    if fmt:
        return fmt

    # Revolut is the one issuer that does NOT sign its letterhead: a business
    # statement leads with "Account statement / <company name>" and only names
    # Revolut in the small print further down. It gets the wide window, but
    # ONLY after every bank that identifies itself properly has had its say — so a
    # Revolut direct debit inside another bank's statement cannot claim the file.
    if "revolut" in head:
        return "revolut_md"

    # Structural fallback — no issuer name survived the PDF extraction.
    if STATEMENT_HEADING_RE.search(t):
        return "wise"
    return None


# Which SpendTrack account a detected format belongs to. Accounts are created by
# the user, so no format maps to a fixed id: `None` = the import dialog asks
# rather than guessing a wrong account onto real money.
FORMAT_ACCOUNT: dict[str, str | None] = {
    "revolut_csv": None,
    "revolut_md": None,
    "wise": None,
    "wise_csv": None,
    "amex_layout_a": None,
    "amex_layout_b": None,
    "trading212_csv": None,
}

FORMAT_LABEL: dict[str, str] = {
    "revolut_csv": "Revolut (CSV export)",
    "revolut_md": "Revolut (PDF statement)",
    "wise": "Wise",
    "wise_csv": "Wise (CSV export)",
    "amex_layout_a": "American Express",
    "amex_layout_b": "American Express",
    "trading212_csv": "Trading 212",
}
