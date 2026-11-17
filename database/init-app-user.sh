#!/bin/sh
# =============================================================================
# SpendTrack (spendtrack): least-privilege application role
# =============================================================================
# Reads SPENDTRACK_APP_DB_PASSWORD from the container env (injected via
# docker-compose `environment:`) instead of hardcoding the password. The value
# reaches SQL only as a psql variable (-v pw=...), quoted as a literal by
# format('%L') — never spliced into the SQL text, so a quote in it cannot break
# or extend the statement.
#
# Runs once on first volume creation. For existing volumes, run manually:
#   docker exec -it spendtrack-postgres psql -U "$POSTGRES_USER" -d spendtrack \
#     -c "\password spendtrack_app"
# =============================================================================
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pw="$SPENDTRACK_APP_DB_PASSWORD" -v db="$POSTGRES_DB" <<'EOSQL'
  SELECT format('CREATE ROLE spendtrack_app WITH LOGIN PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'spendtrack_app')
  \gexec

  GRANT CONNECT ON DATABASE :"db" TO spendtrack_app;
  GRANT USAGE ON SCHEMA public TO spendtrack_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spendtrack_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO spendtrack_app;
EOSQL
