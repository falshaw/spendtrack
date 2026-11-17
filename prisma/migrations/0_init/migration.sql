-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "GoalSource" AS ENUM ('ACCOUNT', 'RESERVE', 'MANUAL');

-- CreateEnum
CREATE TYPE "NetWorthItemKind" AS ENUM ('CAR', 'ASSET', 'LIABILITY');

-- CreateEnum
CREATE TYPE "RuleTier" AS ENUM ('USER', 'LEARNED');

-- CreateEnum
CREATE TYPE "BalanceOrigin" AS ENUM ('STATEMENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "CategoryGroup" AS ENUM ('INCOME', 'NEEDS', 'WANTS', 'SAVINGS');

-- CreateEnum
CREATE TYPE "TxnType" AS ENUM ('EXPENSE', 'INCOME');

-- CreateEnum
CREATE TYPE "AccountBiz" AS ENUM ('PERSONAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('BANK', 'CARD', 'CASH', 'SAVINGS', 'INVESTMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "Cadence" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT,
    "type" "AccountType" NOT NULL DEFAULT 'BANK',
    "biz" "AccountBiz" NOT NULL DEFAULT 'PERSONAL',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "earmark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" "CategoryGroup" NOT NULL DEFAULT 'WANTS',
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "icon" TEXT,
    "monthly_budget" DECIMAL(12,2),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "exclude_from_totals" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT,
    "category_id" TEXT,
    "type" "TxnType" NOT NULL DEFAULT 'EXPENSE',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "date" DATE NOT NULL,
    "accrual_date" DATE,
    "merchant" TEXT NOT NULL,
    "note" TEXT,
    "reviewed" BOOLEAN NOT NULL DEFAULT true,
    "recurring_id" TEXT,
    "receipt_ref" TEXT,
    "display_merchant" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "import_batch" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_attachments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_splits" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "category_id" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transaction_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_rules" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category_id" TEXT,
    "account_id" TEXT,
    "merchant" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "type" "TxnType" NOT NULL DEFAULT 'EXPENSE',
    "cadence" "Cadence" NOT NULL DEFAULT 'MONTHLY',
    "next_date" DATE NOT NULL,
    "end_date" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_dismissals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "GoalSource" NOT NULL DEFAULT 'MANUAL',
    "target" DECIMAL(12,2),
    "target_date" DATE,
    "account_id" TEXT,
    "manual_amount" DECIMAL(12,2),
    "note" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "net_worth_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "NetWorthItemKind" NOT NULL DEFAULT 'ASSET',
    "name" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "as_of" DATE NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "net_worth_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "net_worth_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "cash" DECIMAL(14,2) NOT NULL,
    "cards" DECIMAL(14,2) NOT NULL,
    "trading" DECIMAL(14,2),
    "assets" DECIMAL(14,2) NOT NULL,
    "liabilities" DECIMAL(14,2) NOT NULL,
    "reserve" DECIMAL(14,2),
    "net" DECIMAL(14,2) NOT NULL,
    "detail" JSONB NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "net_worth_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_rules" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "match_text" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "txn_rules" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tier" "RuleTier" NOT NULL DEFAULT 'USER',
    "name" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stop_processing" BOOLEAN NOT NULL DEFAULT true,
    "match_text" TEXT,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "txn_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_apply_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rule_id" TEXT,
    "batch" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "undone_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_apply_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_balances" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "as_of" DATE NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "source" TEXT,
    "origin" "BalanceOrigin" NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserve_steps" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "pay_date" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "invoices_gross" DECIMAL(12,2) NOT NULL,
    "reserve_after" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reserve_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "currency" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "per_eur" DECIMAL(18,8) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ECB',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("currency","date")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_user_id_name_key" ON "accounts"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_user_id_name_key" ON "categories"("user_id", "name");

-- CreateIndex
CREATE INDEX "transactions_user_id_date_idx" ON "transactions"("user_id", "date");

-- CreateIndex
CREATE INDEX "transactions_user_id_accrual_date_idx" ON "transactions"("user_id", "accrual_date");

-- CreateIndex
CREATE INDEX "transactions_user_id_category_id_idx" ON "transactions"("user_id", "category_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_account_id_idx" ON "transactions"("user_id", "account_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_reviewed_idx" ON "transactions"("user_id", "reviewed");

-- CreateIndex
CREATE INDEX "transaction_attachments_user_id_idx" ON "transaction_attachments"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_attachments_transaction_id_sha256_key" ON "transaction_attachments"("transaction_id", "sha256");

-- CreateIndex
CREATE INDEX "transaction_splits_transaction_id_idx" ON "transaction_splits"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_splits_user_id_idx" ON "transaction_splits"("user_id");

-- CreateIndex
CREATE INDEX "recurring_rules_user_id_active_idx" ON "recurring_rules"("user_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_dismissals_user_id_key_key" ON "recurring_dismissals"("user_id", "key");

-- CreateIndex
CREATE INDEX "goals_user_id_archived_idx" ON "goals"("user_id", "archived");

-- CreateIndex
CREATE INDEX "net_worth_items_user_id_idx" ON "net_worth_items"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "net_worth_snapshots_user_id_month_key" ON "net_worth_snapshots"("user_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_rules_user_id_match_text_key" ON "merchant_rules"("user_id", "match_text");

-- CreateIndex
CREATE INDEX "txn_rules_user_id_tier_priority_idx" ON "txn_rules"("user_id", "tier", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "txn_rules_user_id_match_text_key" ON "txn_rules"("user_id", "match_text");

-- CreateIndex
CREATE INDEX "rule_apply_log_user_id_batch_idx" ON "rule_apply_log"("user_id", "batch");

-- CreateIndex
CREATE INDEX "rule_apply_log_transaction_id_idx" ON "rule_apply_log"("transaction_id");

-- CreateIndex
CREATE INDEX "account_balances_user_id_idx" ON "account_balances"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_balances_account_id_as_of_key" ON "account_balances"("account_id", "as_of");

-- CreateIndex
CREATE UNIQUE INDEX "reserve_steps_user_id_pay_date_key" ON "reserve_steps"("user_id", "pay_date");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_id_fkey" FOREIGN KEY ("recurring_id") REFERENCES "recurring_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_attachments" ADD CONSTRAINT "transaction_attachments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_attachments" ADD CONSTRAINT "transaction_attachments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_dismissals" ADD CONSTRAINT "recurring_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "net_worth_items" ADD CONSTRAINT "net_worth_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "net_worth_snapshots" ADD CONSTRAINT "net_worth_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_rules" ADD CONSTRAINT "merchant_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_rules" ADD CONSTRAINT "merchant_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "txn_rules" ADD CONSTRAINT "txn_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_apply_log" ADD CONSTRAINT "rule_apply_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_apply_log" ADD CONSTRAINT "rule_apply_log_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "txn_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_apply_log" ADD CONSTRAINT "rule_apply_log_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_steps" ADD CONSTRAINT "reserve_steps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Hand-written constraints (not expressible in schema.prisma) ─────────────

ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "net_worth_items" ADD CONSTRAINT "net_worth_items_amount_nonneg" CHECK ("amount" >= 0);

-- The parts of a split must equal the parent's amount, checked at COMMIT (deferred)
-- so a PUT that replaces the whole set can delete and re-insert inside one
-- transaction. Fires on the parts and on a parent amount change.
CREATE OR REPLACE FUNCTION check_transaction_splits() RETURNS trigger AS $$
DECLARE
    tid TEXT;
    parent NUMERIC(12,2);
    parts  NUMERIC(12,2);
    n      INTEGER;
BEGIN
    IF TG_TABLE_NAME = 'transactions' THEN
        tid := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        tid := OLD.transaction_id;
    ELSE
        tid := NEW.transaction_id;
    END IF;
    SELECT count(*), coalesce(sum(amount), 0) INTO n, parts FROM transaction_splits WHERE transaction_id = tid;
    IF n = 0 THEN
        RETURN NULL;
    END IF;
    SELECT amount INTO parent FROM transactions WHERE id = tid;
    IF parent IS NULL THEN
        RETURN NULL; -- parent gone: the cascade removes the parts
    END IF;
    IF parts <> parent THEN
        RAISE EXCEPTION 'transaction_splits for % sum to % but the transaction amount is %', tid, parts, parent
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER transaction_splits_sum_check
    AFTER INSERT OR UPDATE OR DELETE ON "transaction_splits"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_transaction_splits();

CREATE CONSTRAINT TRIGGER transactions_amount_splits_check
    AFTER UPDATE OF "amount" ON "transactions"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_transaction_splits();
