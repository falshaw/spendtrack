-- CreateEnum
CREATE TYPE "Broker" AS ENUM ('TRADING212', 'IBKR', 'MANUAL');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('NEVER', 'OK', 'PARTIAL', 'ERROR');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "CashFlowKind" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateTable
CREATE TABLE "broker_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "broker" "Broker" NOT NULL,
    "label" TEXT NOT NULL,
    "account_id" TEXT,
    "base_currency" TEXT NOT NULL DEFAULT 'EUR',
    "cash" DECIMAL(14,2),
    "total_value" DECIMAL(14,2),
    "as_of" DATE,
    "status" "SyncStatus" NOT NULL DEFAULT 'NEVER',
    "last_sync_at" TIMESTAMP(3),
    "last_sync_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investment_holdings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "quantity" DECIMAL(20,8) NOT NULL,
    "avg_cost" DECIMAL(18,6) NOT NULL,
    "price" DECIMAL(18,6),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "value" DECIMAL(14,2),
    "unrealised_pnl" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investment_holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investment_trades" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "price" DECIMAL(18,6) NOT NULL,
    "fees" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investment_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investment_dividends" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "paid_on" DATE NOT NULL,
    "quantity" DECIMAL(20,8),
    "amount" DECIMAL(14,2) NOT NULL,
    "withholding_tax" DECIMAL(14,2),
    "currency" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investment_dividends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investment_cash_flows" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" "CashFlowKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investment_cash_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_values" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "cash" DECIMAL(14,2),
    "currency" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolio_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "broker_connections_user_id_broker_key" ON "broker_connections"("user_id", "broker");

-- CreateIndex
CREATE INDEX "investment_holdings_user_id_idx" ON "investment_holdings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "investment_holdings_connection_id_symbol_key" ON "investment_holdings"("connection_id", "symbol");

-- CreateIndex
CREATE INDEX "investment_trades_user_id_executed_at_idx" ON "investment_trades"("user_id", "executed_at");

-- CreateIndex
CREATE UNIQUE INDEX "investment_trades_connection_id_external_id_key" ON "investment_trades"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "investment_dividends_user_id_paid_on_idx" ON "investment_dividends"("user_id", "paid_on");

-- CreateIndex
CREATE UNIQUE INDEX "investment_dividends_connection_id_external_id_key" ON "investment_dividends"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "investment_cash_flows_user_id_date_idx" ON "investment_cash_flows"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "investment_cash_flows_connection_id_external_id_key" ON "investment_cash_flows"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "portfolio_values_user_id_date_idx" ON "portfolio_values"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_values_connection_id_date_key" ON "portfolio_values"("connection_id", "date");

-- AddForeignKey
ALTER TABLE "broker_connections" ADD CONSTRAINT "broker_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_connections" ADD CONSTRAINT "broker_connections_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_holdings" ADD CONSTRAINT "investment_holdings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_holdings" ADD CONSTRAINT "investment_holdings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "broker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_trades" ADD CONSTRAINT "investment_trades_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_trades" ADD CONSTRAINT "investment_trades_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "broker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_dividends" ADD CONSTRAINT "investment_dividends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_dividends" ADD CONSTRAINT "investment_dividends_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "broker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_cash_flows" ADD CONSTRAINT "investment_cash_flows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_cash_flows" ADD CONSTRAINT "investment_cash_flows_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "broker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_values" ADD CONSTRAINT "portfolio_values_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_values" ADD CONSTRAINT "portfolio_values_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "broker_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

