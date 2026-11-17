"""Shared setup for the statement-parser tests.

The suite drives the REAL code in `scripts/` — `parse_statements`, `bank_detect`,
`statement_service` — never a copy. Every fixture is synthetic (the CSVs in
`fixtures/` or written inline in the tests): no real statement, account number
or counterparty belongs in this directory.

    npm run test:parser        # = python -m pytest tests/parser -q
"""
import os
import sys

import pytest

# The service fails closed without a token; the in-process client sends it.
os.environ.setdefault("PARSER_TOKEN", "test-parser-token")

APP_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(APP_ROOT, "scripts")
STATEMENTS = os.path.join(APP_ROOT, "tests", "parser", "fixtures")

if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


@pytest.fixture(scope="session")
def statements_dir() -> str:
    return STATEMENTS


@pytest.fixture(scope="session")
def client():
    """In-process client for the FastAPI app — same routing and multipart parsing
    as the container, no network and no Ollama."""
    from fastapi.testclient import TestClient

    import statement_service

    return TestClient(statement_service.app, headers={"X-Parser-Token": os.environ["PARSER_TOKEN"]})


def fixture_path(name: str) -> str:
    return os.path.join(STATEMENTS, name)
