/**
 * The zod layer is the only thing between a request body and the database, so
 * the cases worth pinning are the ones that would write bad money: a negative
 * amount, a currency the app cannot convert, a date range that runs backwards.
 */
import { describe, expect, it } from "vitest";
import {
  AccountCreateSchema,
  AccountUpdateSchema,
  CategoryCreateSchema,
  ImportCommitSchema,
  LoginSchema,
  RecurringCreateSchema,
  TransactionCreateSchema,
  TransactionUpdateSchema,
  parseRequest,
} from "@/lib/validators";

const req = (body: unknown) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("parseRequest", () => {
  it("returns parsed data for a valid body", async () => {
    const r = await parseRequest(LoginSchema, req({ email: "user@example.com", password: "pw" }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("user@example.com");
  });

  it("400s on invalid JSON", async () => {
    const bad = new Request("http://localhost/api/x", { method: "POST", body: "{oops" });
    const r = await parseRequest(LoginSchema, bad);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.response.status).toBe(400);
  });

  it("400s on a schema violation and says what failed", async () => {
    const r = await parseRequest(LoginSchema, req({ email: "not-an-email", password: "" }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.response.status).toBe(400);
      await expect(r.response.json()).resolves.toMatchObject({
        error: "Validation failed",
      });
    }
  });
});

describe("money and currency", () => {
  const base = { date: "2026-08-30", merchant: "Freshmart" };

  it("refuses a zero or negative amount", () => {
    expect(TransactionCreateSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(TransactionCreateSchema.safeParse({ ...base, amount: -1 }).success).toBe(false);
  });

  it("refuses an absurd amount rather than storing it", () => {
    expect(
      TransactionCreateSchema.safeParse({ ...base, amount: 10_000_000_000 }).success,
    ).toBe(false);
  });

  it("refuses a currency the app has no rate for", () => {
    expect(
      TransactionCreateSchema.safeParse({ ...base, amount: 10, currency: "XYZ" }).success,
    ).toBe(false);
    expect(
      TransactionCreateSchema.safeParse({ ...base, amount: 10, currency: "SEK" }).success,
    ).toBe(true);
  });

  it("defaults an expense in EUR", () => {
    const r = TransactionCreateSchema.parse({ ...base, amount: 10 });
    expect(r).toMatchObject({ type: "EXPENSE", currency: "EUR" });
  });

  it("refuses a merchant-less or date-less row", () => {
    expect(TransactionCreateSchema.safeParse({ amount: 1, date: "2026-08-30" }).success).toBe(false);
    expect(TransactionCreateSchema.safeParse({ amount: 1, merchant: "x" }).success).toBe(false);
  });

  it("refuses a date that is not a date", () => {
    expect(
      TransactionCreateSchema.safeParse({ ...base, amount: 1, date: "the 30th" }).success,
    ).toBe(false);
  });
});

describe("accrual date", () => {
  it("accepts an accrual date", () => {
    const r = TransactionUpdateSchema.parse({ accrualDate: "2026-10-21" });
    expect(r).toMatchObject({ accrualDate: "2026-10-21" });
  });

  it("accepts an explicit null to clear it", () => {
    expect(TransactionUpdateSchema.parse({ accrualDate: null }).accrualDate).toBeNull();
  });

  it("refuses a nonsense accrual date", () => {
    expect(TransactionUpdateSchema.safeParse({ accrualDate: "soon" }).success).toBe(false);
  });
});

describe("other schemas", () => {
  it("requires a hex colour on an account", () => {
    expect(AccountCreateSchema.safeParse({ name: "R", color: "red" }).success).toBe(false);
    expect(AccountCreateSchema.parse({ name: "R", color: "#bf5a36" }).color).toBe("#bf5a36");
  });

  it("defaults an account to a personal EUR bank account", () => {
    expect(AccountCreateSchema.parse({ name: "R" })).toMatchObject({
      type: "BANK",
      biz: "PERSONAL",
      currency: "EUR",
    });
  });

  it("refuses an unknown business scope", () => {
    expect(AccountUpdateSchema.safeParse({ biz: "US_BUSINESS" }).success).toBe(false);
  });

  it("defaults a category to WANTS", () => {
    expect(CategoryCreateSchema.parse({ name: "Food" }).group).toBe("WANTS");
  });

  it("refuses a negative category budget", () => {
    expect(CategoryCreateSchema.safeParse({ name: "Food", monthlyBudget: -5 }).success).toBe(false);
  });

  it("requires a next date on a recurring rule and defaults the cadence", () => {
    expect(RecurringCreateSchema.safeParse({ merchant: "Rent", amount: 1 }).success).toBe(false);
    expect(
      RecurringCreateSchema.parse({ merchant: "Rent", amount: 1, nextDate: "2026-09-01" }).cadence,
    ).toBe("MONTHLY");
  });

  it("validates every row of an import batch, not just the first", () => {
    const rows = [
      { date: "2026-08-01", merchant: "a", amount: 1, type: "EXPENSE" },
      { date: "2026-08-02", merchant: "b", amount: -3, type: "EXPENSE" },
    ];
    expect(ImportCommitSchema.safeParse({ rows }).success).toBe(false);
  });
});
