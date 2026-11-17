"""Localised keywords for the statement and receipt readers.

The CSV importer and the receipt-split helper in the app keep the same kind of
table in src/lib/l10n-keywords.ts.

A statement or receipt is printed in whatever language the issuer, or the
customer's app, was set to. The parsers themselves are language-neutral: every
word they look for lives in the tables below, one entry per language. To support
another language, add one entry to each table — no parser code changes.

The keys are ISO 639-1 language codes. English is the base layout; the other
entries cover the decimal-comma layouts ("1.234,56", "27. <month> 2026").
"""
import re

# ───────────────────────────── currencies ─────────────────────────────
# EUR plus the ECB euro reference-rate currencies, alphabetical — the same list
# as SUPPORTED_CURRENCIES in src/lib/currency.ts.
CURRENCY_CODES = (
    "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD",
    "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK",
    "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
)
CURRENCY_RE = "|".join(CURRENCY_CODES)

# ───────────────────────────── month names ─────────────────────────────
MONTH_NAMES: dict[str, list[str]] = {
    "en": ["january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december"],
    "de": ["januar", "februar", "märz", "april", "mai", "juni", "juli",
           "august", "september", "oktober", "november", "dezember"],
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
           "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    "fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
           "août", "septembre", "octobre", "novembre", "décembre"],
    "it": ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio",
           "agosto", "settembre", "ottobre", "novembre", "dicembre"],
}

# Abbreviations that are not a prefix of the full name.
MONTH_ALIASES = {"mrz": 3}


def _build_month_lookup() -> dict[str, int]:
    """Full names plus every 3- and 4-letter prefix that means ONE month across
    all languages ("sept" -> 9; a prefix shared by two months is left out)."""
    full: dict[str, int] = {}
    prefixes: dict[str, set[int]] = {}
    for names in MONTH_NAMES.values():
        for idx, name in enumerate(names, 1):
            full[name] = idx
            for n in (3, 4):
                if len(name) >= n:
                    prefixes.setdefault(name[:n], set()).add(idx)
    lookup = {p: next(iter(s)) for p, s in prefixes.items() if len(s) == 1}
    lookup.update(full)
    lookup.update(MONTH_ALIASES)
    return lookup


MONTH_LOOKUP = _build_month_lookup()
# A month word inside a regex: any known prefix, then the rest of the word.
MONTH_WORD_RE = (
    "(?:" + "|".join(sorted((re.escape(k) for k in MONTH_LOOKUP if len(k) <= 4),
                            key=len, reverse=True)) + r")[^\W\d_]*\.?"
)


def month_index(word: str) -> int | None:
    """1-12 for a month name or abbreviation in any table language, else None."""
    w = word.lower().rstrip(".")
    return MONTH_LOOKUP.get(w) or MONTH_LOOKUP.get(w[:4]) or MONTH_LOOKUP.get(w[:3])


# ───────────────────── multi-currency account statement ─────────────────────
# "<CCY> statement" heading, the account-holder line and the description column
# header. A statement showing any non-English marker uses decimal commas.
STATEMENT_WORD = {"en": "statement", "de": "auszug", "es": "extracto",
                  "fr": "relevé", "it": "estratto"}
ACCOUNT_HOLDER = {"de": "kontoinhaber", "es": "titular de la cuenta",
                  "fr": "titulaire du compte", "it": "intestatario del conto"}
DESCRIPTION_HEADER = {"de": "beschreibung", "es": "descripción", "it": "descrizione"}

STATEMENT_HEADING_RE = re.compile(
    r"\b(" + CURRENCY_RE + r")[\s-]+(?i:" + "|".join(STATEMENT_WORD.values()) + ")")

_local_markers = (
    [rf"\b(?:{CURRENCY_RE})[\s-]+(?i:{w})" for k, w in STATEMENT_WORD.items() if k != "en"]
    + [rf"(?i:{re.escape(w)})" for w in ACCOUNT_HOLDER.values()]
    + [rf"(?i:\b{w}\b)" for w in DESCRIPTION_HEADER.values()]
)
DECIMAL_COMMA_MARKER_RE = re.compile("|".join(_local_markers))

# Card rows: "<lead> <amount> <CCY> <issued-by> <merchant>".
CARD_TRANSACTION = {
    "en": ("card transaction of", "issued by"),
    "de": ("kartentransaktion über", "bei"),
    "es": ("transacción con tarjeta de", "emitida por"),
    "fr": ("transaction par carte de", "émise par"),
    "it": ("transazione con carta di", "emessa da"),
}
CARD_TRANSACTION_RE = (
    "(?:" + "|".join(lead for lead, _ in CARD_TRANSACTION.values()) + ")"
    r"\s+(-?[\d.,]+)\s*([A-Z]{3})\s+"
    "(?:" + "|".join(by for _, by in CARD_TRANSACTION.values()) + r")\s+(.+)$"
)

# ───────────────────── card statement, numeric-date layout ─────────────────────
# Billing period "<from> DD.MM.YY <to> DD.MM.YY", the credits/debits summary
# header, the credit markers on a row, and the activity-export column headers.
PERIOD_WORDS = {"de": ("vom", "bis"), "es": ("del", "al"),
                "fr": ("du", "au"), "it": ("dal", "al")}
SUMMARY_WORDS = {"de": ("gutschriften", "belastungen"), "es": ("abonos", "cargos"),
                 "fr": ("crédits", "débits"), "it": ("accrediti", "addebiti")}
CREDIT_MARKERS = {"de": ("gutschrift", "zahlung erhalten"),
                  "es": ("abono", "pago recibido"),
                  "fr": ("avoir", "paiement reçu"),
                  "it": ("accredito", "pagamento ricevuto")}
ACTIVITY_HEADERS = {"de": ("beschreibung", "betrag"), "es": ("descripción", "importe"),
                    "fr": ("description", "montant"), "it": ("descrizione", "importo")}

_from = "|".join(sorted({f for f, _ in PERIOD_WORDS.values()}))
_to = "|".join(sorted({t for _, t in PERIOD_WORDS.values()}))
PERIOD_RE = re.compile(
    rf"\b(?:{_from})\s+(\d{{2}})\.(\d{{2}})\.(\d{{2}})\s*(?:{_to})\s*(\d{{2}})\.(\d{{2}})\.(\d{{2}})",
    re.I)
CREDIT_MARKER_RE = re.compile(
    r"\b(?:" + "|".join(m for pair in CREDIT_MARKERS.values() for m in pair) + ")", re.I)


def has_summary_header(line: str) -> bool:
    """True when one line carries a language's credits AND debits column words."""
    low = line.lower()
    return any(c in low and d in low for c, d in SUMMARY_WORDS.values())


def has_activity_headers(text_lower: str) -> bool:
    return any(a in text_lower and b in text_lower for a, b in ACTIVITY_HEADERS.values())


# ───────────────────────────── receipt labels ─────────────────────────────
# What the receipt reader's second pass may find printed next to an amount.
# PAYABLE: highest priority first — a part-payment beats a grand total, which
# beats a plain total. A bare "deposit" is NOT a payment instruction (on an
# invoice it can be an item); it only counts next to a pay/due/now word.
PAYABLE_LABELS: list[tuple[str, dict[str, str]]] = [
    ("due_now", {
        "en": r"due\s*now|now\s*due|payable\s*now|amount\s*payable|part\s*payment|"
              r"deposit\s*(?:due|now|payable|to\s*pay)|(?:due|now|payable|pay)\s*deposit",
        "de": r"anzahlung|jetzt\s*f[äa]llig",
        "es": r"pago\s*a\s*cuenta|a\s*pagar\s*ahora",
        "fr": r"acompte|à\s*payer\s*maintenant",
        "it": r"acconto|da\s*pagare\s*ora",
    }),
    ("grand", {
        "en": r"grand\s*total|amount\s*due|total\s*due",
        "de": r"zu\s*zahlen|gesamtbetrag|endbetrag",
        "es": r"total\s*a\s*pagar|importe\s*total",
        "fr": r"montant\s*d[uû]|total\s*ttc",
        "it": r"totale\s*da\s*pagare|importo\s*totale",
    }),
    ("total", {
        "en": r"^total$|^total\b",
        "de": r"gesamt|summe",
        "es": r"^total\b",
        "fr": r"^total\b",
        "it": r"^totale\b",
    }),
]
PAYABLE_PRIORITY: list[tuple[str, str]] = [
    (name, "|".join(dict.fromkeys(by_lang.values()))) for name, by_lang in PAYABLE_LABELS
]

# Labels that are NEVER the payable figure, however prominently they are printed.
NEVER_PAYABLE_LABELS: dict[str, dict[str, str]] = {
    "subtotal": {"en": r"subtotal|sub\s*total|net\b", "de": r"zwischensumme|netto",
                 "es": r"base\s*imponible", "fr": r"sous[-\s]*total|total\s*ht",
                 "it": r"imponibile"},
    "tax": {"en": r"vat|tax", "de": r"mwst|ust\b", "es": r"\biva\b", "fr": r"\btva\b",
            "it": r"\biva\b"},
    "discount": {"en": r"discount", "de": r"rabatt", "es": r"descuento", "fr": r"remise",
                 "it": r"sconto"},
    "tip": {"en": r"tip", "de": r"trinkgeld", "es": r"propina", "fr": r"pourboire",
            "it": r"mancia"},
    "rounding": {"en": r"round", "de": r"rundung", "es": r"redondeo", "fr": r"arrondi",
                 "it": r"arrotondamento"},
    "change": {"en": r"change", "de": r"wechselgeld", "es": r"vuelto", "fr": r"monnaie",
               "it": r"\bresto\b"},
    "balance": {"en": r"balance\s*(remaining|due\s*on|on\s*completion)", "de": r"restbetrag",
                "es": r"saldo\s*pendiente", "fr": r"solde\s*restant", "it": r"saldo\s*residuo"},
    "conversion": {"en": r"approx|≈|conversion", "de": r"umrechnung", "es": r"conversión",
                   "fr": r"taux\s*de\s*change", "it": r"tasso\s*di\s*cambio"},
}
NEVER_PAYABLE = re.compile(
    "|".join(dict.fromkeys(p for by_lang in NEVER_PAYABLE_LABELS.values()
                           for p in by_lang.values())),
    re.I,
)
