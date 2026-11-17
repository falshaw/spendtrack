/**
 * Demo data for screenshots and a first look: twelve months of FICTIONAL transactions for the seeded user
 * (accounts, budgets, recurring bills, goals, balances, net-worth snapshots, a demo investment portfolio).
 * Every merchant, employer, client, holding and trade here is made up. Amounts are EUR unless marked.
 *
 * It REPLACES the seeded user's data, so it refuses to run without DEMO_SEED_CONFIRM=1:
 *   DEMO_SEED_CONFIRM=1 npx tsx scripts/seed-demo.ts
 * Run `npm run db:seed` first (creates the user + default categories).
 */
import { prisma } from "../src/lib/prisma";
import { snapshotMonth } from "../src/lib/net-worth-data";
import { toEur } from "../src/lib/currency";

if (process.env.DEMO_SEED_CONFIRM !== "1") {
  console.error("Refusing to run: this replaces the user's data with demo data. Set DEMO_SEED_CONFIRM=1.");
  process.exit(1);
}

// Deterministic pseudo-random so the screenshots stay the same between runs.
let seed = 20261117;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const between = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

const TODAY = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
const LAST = new Date(TODAY.getTime() - 86_400_000); // data up to yesterday
const FIRST = day(LAST.getUTCFullYear() - 1, LAST.getUTCMonth(), 1);

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user ${email} — run npm run db:seed first`);
  const userId = user.id;
  await prisma.user.update({ where: { id: userId }, data: { name: "Demo User" } });

  // ── wipe this user's data (categories are kept and re-budgeted) ──
  await prisma.netWorthSnapshot.deleteMany({ where: { userId } });
  await prisma.netWorthItem.deleteMany({ where: { userId } });
  await prisma.goal.deleteMany({ where: { userId } });
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.recurringRule.deleteMany({ where: { userId } });
  await prisma.accountBalance.deleteMany({ where: { userId } });
  await prisma.reserveStep.deleteMany({ where: { userId } });
  await prisma.txnRule.deleteMany({ where: { userId } });
  await prisma.account.deleteMany({ where: { userId } });

  const cats = await prisma.category.findMany({ where: { userId } });
  const cat = (name: string) => {
    const c = cats.find((x) => x.name === name);
    if (!c) throw new Error(`category ${name} missing — run npm run db:seed`);
    return c.id;
  };
  const BUDGETS: Record<string, number> = {
    Rent: 1250,
    Groceries: 480,
    Utilities: 210,
    Transport: 120,
    "Dining Out": 220,
    Entertainment: 80,
    Shopping: 200,
    Subscriptions: 45,
    Health: 60,
  };
  // The Sunset categorical order (src/components/charts/theme.ts) on the eight biggest spend categories;
  // the tail shares the neutral grey and folds into "Other" in the donut.
  const COLORS: Record<string, string> = {
    Rent: "#e2553c",
    Groceries: "#008a9e",
    Shopping: "#b97800",
    "Dining Out": "#7d4fb0",
    Utilities: "#5a9a2c",
    Travel: "#d64f8a",
    Transport: "#2f62b8",
    Tax: "#9a5a2a",
    Salary: "#008a9e",
    "Other Income": "#5a9a2c",
  };
  for (const c of cats) {
    await prisma.category.update({
      where: { id: c.id },
      data: { monthlyBudget: BUDGETS[c.name] ?? null, color: COLORS[c.name] ?? "#a59c8e" },
    });
  }

  // ── accounts ──
  const mk = (name: string, institution: string, type: "BANK" | "CARD" | "SAVINGS" | "INVESTMENT", biz: "PERSONAL" | "BUSINESS", color: string, sortOrder: number, earmark?: string) =>
    prisma.account.create({ data: { userId, name, institution, type, biz, color, sortOrder, currency: "EUR", earmark } });
  const everyday = await mk("Everyday Account", "Demo Bank", "BANK", "PERSONAL", "#e2553c", 0);
  const card = await mk("Credit Card", "Demo Card Co", "CARD", "PERSONAL", "#7d4fb0", 1);
  const pot = await mk("Savings Pot", "Demo Bank", "SAVINGS", "PERSONAL", "#5a9a2c", 2, "Emergency fund");
  const studio = await mk("Studio Business", "Example Business Bank", "BANK", "BUSINESS", "#008a9e", 3);
  const fund = await mk("Index Fund", "Sample Broker", "INVESTMENT", "PERSONAL", "#2f62b8", 4);

  type Row = { date: Date; merchant: string; amount: number; type: "EXPENSE" | "INCOME"; categoryId: string | null; accountId: string; reviewed?: boolean };
  const rows: Row[] = [];
  const add = (r: Row) => {
    if (r.date >= FIRST && r.date <= LAST) rows.push(r);
  };

  const GROCERS = ["FreshCart Grocers", "Corner Market", "Green Basket", "Daily Harvest"] as const;
  const DINING = ["Bean & Leaf Café", "Pasta Palace", "Noodle Corner", "The Copper Pot", "Sunny Side Diner"] as const;
  const SHOPS = ["UrbanThreads", "PageTurner Books", "HomeNest", "GadgetGrove"] as const;
  const FUN = ["Cinema Nova", "Bowling Galaxy", "Live Room Tickets"] as const;

  for (let i = 0; i < 13; i++) {
    const y = FIRST.getUTCFullYear();
    const m = FIRST.getUTCMonth() + i;
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    // income
    add({ date: day(y, m, 25), merchant: "Demo Employer Ltd", amount: 3850, type: "INCOME", categoryId: cat("Salary"), accountId: everyday.id });
    add({ date: day(y, m, 12), merchant: "Acme Corp", amount: between(1100, 1600), type: "INCOME", categoryId: cat("Other Income"), accountId: studio.id });
    // fixed bills
    add({ date: day(y, m, 1), merchant: "Maple Lettings", amount: 1250, type: "EXPENSE", categoryId: cat("Rent"), accountId: everyday.id });
    add({ date: day(y, m, 4), merchant: "VoltPower Energy", amount: between(70, 145), type: "EXPENSE", categoryId: cat("Utilities"), accountId: everyday.id });
    add({ date: day(y, m, 6), merchant: "NetSpeed Fibre", amount: 39, type: "EXPENSE", categoryId: cat("Utilities"), accountId: everyday.id });
    add({ date: day(y, m, 9), merchant: "AquaFlow Water", amount: between(24, 36), type: "EXPENSE", categoryId: cat("Utilities"), accountId: everyday.id });
    add({ date: day(y, m, 2), merchant: "CityLine Transit pass", amount: 49, type: "EXPENSE", categoryId: cat("Transport"), accountId: card.id });
    add({ date: day(y, m, 3), merchant: "StreamBox", amount: 12.99, type: "EXPENSE", categoryId: cat("Subscriptions"), accountId: card.id });
    add({ date: day(y, m, 14), merchant: "SoundWave Music", amount: 10.99, type: "EXPENSE", categoryId: cat("Subscriptions"), accountId: card.id });
    add({ date: day(y, m, 5), merchant: "FitHub Gym", amount: 34, type: "EXPENSE", categoryId: cat("Health"), accountId: card.id });
    add({ date: day(y, m, 15), merchant: "SafeHome Insurance", amount: 42.5, type: "EXPENSE", categoryId: cat("Insurance"), accountId: everyday.id });
    add({ date: day(y, m, 26), merchant: "Transfer to Savings Pot", amount: 400, type: "EXPENSE", categoryId: cat("Transfers"), accountId: everyday.id });
    add({ date: day(y, m, 26), merchant: "Transfer from Everyday Account", amount: 400, type: "INCOME", categoryId: cat("Transfers"), accountId: pot.id });
    add({ date: day(y, m, 13), merchant: "Business bank fee", amount: 9, type: "EXPENSE", categoryId: cat("Fees"), accountId: studio.id });
    if (m % 3 === 0) add({ date: day(y, m, 20), merchant: "Tax Office", amount: 420, type: "EXPENSE", categoryId: cat("Tax"), accountId: studio.id });
    // day-to-day
    for (let d = 1; d <= dim; d += pick([2, 3, 4])) {
      add({ date: day(y, m, d), merchant: pick(GROCERS), amount: between(18, 82), type: "EXPENSE", categoryId: cat("Groceries"), accountId: pick([card.id, everyday.id]) });
    }
    const dinners = 4 + Math.floor(rnd() * 5);
    for (let k = 0; k < dinners; k++) {
      add({ date: day(y, m, 1 + Math.floor(rnd() * dim)), merchant: pick(DINING), amount: between(11, 58), type: "EXPENSE", categoryId: cat("Dining Out"), accountId: card.id });
    }
    for (let k = 0; k < 2 + Math.floor(rnd() * 3); k++) {
      add({ date: day(y, m, 1 + Math.floor(rnd() * dim)), merchant: pick(SHOPS), amount: between(14, 120), type: "EXPENSE", categoryId: cat("Shopping"), accountId: card.id });
    }
    for (let k = 0; k < 1 + Math.floor(rnd() * 2); k++) {
      add({ date: day(y, m, 1 + Math.floor(rnd() * dim)), merchant: pick(FUN), amount: between(9, 45), type: "EXPENSE", categoryId: cat("Entertainment"), accountId: card.id });
    }
    for (let k = 0; k < 3; k++) {
      add({ date: day(y, m, 1 + Math.floor(rnd() * dim)), merchant: pick(["RideNow", "QuickFuel", "CityLine Transit"]), amount: between(6, 32), type: "EXPENSE", categoryId: cat("Transport"), accountId: card.id });
    }
    if (rnd() < 0.5) add({ date: day(y, m, 1 + Math.floor(rnd() * dim)), merchant: "PharmaPlus", amount: between(8, 30), type: "EXPENSE", categoryId: cat("Health"), accountId: card.id });
    // holidays twice a year
    const mm = ((m % 12) + 12) % 12;
    if (mm === 6 || mm === 11) {
      add({ date: day(y, m, 8), merchant: "Skyward Air", amount: between(280, 420), type: "EXPENSE", categoryId: cat("Travel"), accountId: card.id });
      add({ date: day(y, m, 18), merchant: "Seaview Hotel", amount: between(450, 690), type: "EXPENSE", categoryId: cat("Travel"), accountId: card.id });
    }
    if (mm === 3) add({ date: day(y, m, 11), merchant: "GadgetGrove", amount: 1149, type: "EXPENSE", categoryId: cat("Shopping"), accountId: card.id });
    // card settled from the everyday account
    add({ date: day(y, m, 28), merchant: "Credit card repayment", amount: 0, type: "EXPENSE", categoryId: cat("Transfers"), accountId: everyday.id });
  }

  // card repayment = what the card spent that month; mirror as card-side credit
  for (const r of rows.filter((x) => x.merchant === "Credit card repayment")) {
    const y = r.date.getUTCFullYear();
    const m = r.date.getUTCMonth();
    const spent = rows
      .filter((x) => x.accountId === card.id && x.type === "EXPENSE" && x.date.getUTCFullYear() === y && x.date.getUTCMonth() === m)
      .reduce((s, x) => s + x.amount, 0);
    r.amount = Math.round(spent * 100) / 100;
    rows.push({ date: r.date, merchant: "Repayment received", amount: r.amount, type: "INCOME", categoryId: cat("Transfers"), accountId: card.id });
  }
  const repaid = rows.filter((x) => x.amount > 0);

  // a few fresh rows to review, and one unusual charge
  repaid.push(
    { date: new Date(LAST.getTime() - 2 * 86_400_000), merchant: "Mystery Mart 0421", amount: 27.4, type: "EXPENSE", categoryId: null, accountId: card.id, reviewed: false },
    { date: new Date(LAST.getTime() - 1 * 86_400_000), merchant: "Online Order #8812", amount: 64.9, type: "EXPENSE", categoryId: null, accountId: card.id, reviewed: false },
    { date: new Date(LAST.getTime() - 1 * 86_400_000), merchant: "Lakeside Bistro", amount: 186, type: "EXPENSE", categoryId: cat("Dining Out"), accountId: card.id, reviewed: false },
  );

  await prisma.transaction.createMany({
    data: repaid.map((r) => ({
      userId,
      accountId: r.accountId,
      categoryId: r.categoryId,
      type: r.type,
      amount: r.amount,
      currency: "EUR",
      date: r.date,
      merchant: r.merchant,
      reviewed: r.reviewed ?? true,
    })),
  });

  // ── month-end balances, rolled from an opening balance ──
  const opening: Record<string, number> = { [everyday.id]: 2600, [card.id]: 0, [pot.id]: 5200, [studio.id]: 1800 };
  for (let i = 0; i < 12; i++) {
    const end = new Date(Date.UTC(FIRST.getUTCFullYear(), FIRST.getUTCMonth() + i + 1, 0));
    if (end > LAST) break;
    for (const acc of [everyday, card, pot, studio]) {
      const flow = repaid
        .filter((r) => r.accountId === acc.id && r.date <= end)
        .reduce((s, r) => s + (r.type === "INCOME" ? r.amount : -r.amount), 0);
      await prisma.accountBalance.create({
        data: { userId, accountId: acc.id, asOf: end, balance: Math.round((opening[acc.id] + flow) * 100) / 100, currency: "EUR", source: "demo statement", origin: "STATEMENT" },
      });
    }
    await prisma.accountBalance.create({
      data: { userId, accountId: fund.id, asOf: end, balance: Math.round((8200 + i * 310 + between(-250, 250)) * 100) / 100, currency: "EUR", source: "manual", origin: "MANUAL" },
    });
  }

  // ── recurring rules (next occurrence after today) ──
  const nextOn = (d: number) => {
    const t = day(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), d);
    return t >= TODAY ? t : day(TODAY.getUTCFullYear(), TODAY.getUTCMonth() + 1, d);
  };
  const rule = (merchant: string, amount: number, d: number, category: string, accountId: string, type: "EXPENSE" | "INCOME" = "EXPENSE") =>
    prisma.recurringRule.create({ data: { userId, merchant, amount, currency: "EUR", type, cadence: "MONTHLY", nextDate: nextOn(d), categoryId: cat(category), accountId } });
  await rule("Demo Employer Ltd", 3850, 25, "Salary", everyday.id, "INCOME");
  await rule("Maple Lettings", 1250, 1, "Rent", everyday.id);
  await rule("NetSpeed Fibre", 39, 6, "Utilities", everyday.id);
  await rule("StreamBox", 12.99, 3, "Subscriptions", card.id);
  await rule("SoundWave Music", 10.99, 14, "Subscriptions", card.id);
  await rule("FitHub Gym", 34, 5, "Health", card.id);
  await rule("SafeHome Insurance", 42.5, 15, "Insurance", everyday.id);
  await rule("Acme Corp", 1350, 12, "Other Income", studio.id, "INCOME");

  // ── a few rules (user tier) and learned merchant rules ──
  const userRules: { name: string; payee: string; op: string; categoryId: string; display?: string; tags?: string[] }[] = [
    { name: "Groceries", payee: "FreshCart", op: "contains", categoryId: cat("Groceries"), tags: ["food"] },
    { name: "Card repayments are transfers", payee: "Credit card repayment", op: "contains", categoryId: cat("Transfers") },
    { name: "Ride hailing", payee: "RideNow", op: "contains", categoryId: cat("Transport"), display: "RideNow taxi" },
    { name: "Streaming", payee: "StreamBox", op: "contains", categoryId: cat("Subscriptions"), tags: ["streaming"] },
  ];
  for (let i = 0; i < userRules.length; i++) {
    const r = userRules[i];
    await prisma.txnRule.create({
      data: {
        userId, tier: "USER", name: r.name, priority: i, matchText: null,
        conditions: { payee: { op: r.op, value: r.payee } },
        actions: { categoryId: r.categoryId, ...(r.display ? { displayMerchant: r.display } : {}), ...(r.tags ? { tags: r.tags } : {}) },
      },
    });
  }
  for (const [key, name] of [["pasta palace", "Dining Out"], ["corner market", "Groceries"], ["voltpower", "Utilities"]] as const) {
    await prisma.txnRule.create({
      data: { userId, tier: "LEARNED", name: key, matchText: key, conditions: { payee: { op: "word", value: key } }, actions: { categoryId: cat(name) } },
    });
  }

  // ── goals + net-worth items ──
  await prisma.goal.createMany({
    data: [
      { userId, name: "Emergency fund", source: "ACCOUNT", accountId: pot.id, target: 12000, targetDate: day(TODAY.getUTCFullYear() + 1, 5, 30), sortOrder: 0 },
      { userId, name: "Summer trip", source: "MANUAL", manualAmount: 1350, target: 2200, targetDate: day(TODAY.getUTCFullYear() + 1, 6, 1), sortOrder: 1 },
      { userId, name: "New bike", source: "MANUAL", manualAmount: 480, target: 900, sortOrder: 2 },
    ],
  });
  await prisma.netWorthItem.createMany({
    data: [
      { userId, kind: "CAR", name: "Family car", amount: 9500, currency: "EUR", asOf: day(TODAY.getUTCFullYear(), 0, 1) },
      { userId, kind: "LIABILITY", name: "Study loan", amount: 4200, currency: "EUR", asOf: day(TODAY.getUTCFullYear(), 0, 1) },
    ],
  });

  // ── investments: a FICTIONAL demo portfolio (round numbers, made-up dates) ──
  // Stored as if synced, but no broker is connected: the page shows "not connected".
  await prisma.brokerConnection.deleteMany({ where: { userId } }); // cascades holdings + history
  type DemoHolding = { symbol: string; name: string; quantity: number; avgCost: number; price: number; currency: string };
  type DemoBook = {
    broker: "TRADING212" | "IBKR";
    label: string;
    base: string;
    cash: number;
    holdings: DemoHolding[];
    /** [symbol, per-share payout, months it pays (0-11)] */
    payouts: [string, number, number[]][];
    withholding: number;
    deposits: { monthsAgo: number; amount: number }[];
  };
  const books: DemoBook[] = [
    {
      broker: "TRADING212",
      label: "Trading 212",
      base: "EUR",
      cash: 250,
      holdings: [
        { symbol: "VWCE", name: "Demo All-World ETF", quantity: 40, avgCost: 100, price: 120, currency: "EUR" },
        { symbol: "AAPL", name: "Apple Inc", quantity: 10, avgCost: 150, price: 200, currency: "USD" },
        { symbol: "MSFT", name: "Microsoft Corp", quantity: 5, avgCost: 300, price: 400, currency: "USD" },
        { symbol: "ASML", name: "ASML Holding", quantity: 2, avgCost: 600, price: 650, currency: "EUR" },
      ],
      payouts: [
        ["AAPL", 0.25, [1, 4, 7, 10]],
        ["MSFT", 0.8, [2, 5, 8, 11]],
        ["VWCE", 0.5, [2, 8]],
      ],
      withholding: 0,
      deposits: Array.from({ length: 12 }, (_, i) => ({ monthsAgo: i, amount: 300 })),
    },
    {
      broker: "IBKR",
      label: "Interactive Brokers",
      base: "USD",
      cash: 1000,
      holdings: [
        { symbol: "VTI", name: "Demo Total Market ETF", quantity: 15, avgCost: 200, price: 250, currency: "USD" },
        { symbol: "KO", name: "Coca-Cola Co", quantity: 50, avgCost: 55, price: 60, currency: "USD" },
        { symbol: "JNJ", name: "Johnson & Johnson", quantity: 20, avgCost: 150, price: 140, currency: "USD" },
      ],
      payouts: [
        ["KO", 0.5, [3, 6, 9, 0]],
        ["JNJ", 1.2, [2, 5, 8, 11]],
        ["VTI", 0.9, [2, 5, 8, 11]],
      ],
      withholding: 0.15,
      deposits: [
        { monthsAgo: 11, amount: 5000 },
        { monthsAgo: 5, amount: 2000 },
      ],
    },
  ];
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // Instrument → base currency at today's (static demo) rate.
  const toBase = (amount: number, from: string, base: string) => (from === base ? amount : toEur(amount, from) / toEur(1, base));
  const monthsAgo = (n: number, d: number) => day(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - n, d);
  let holdingCount = 0;
  for (const b of books) {
    const values = b.holdings.map((h) => ({ ...h, value: r2(toBase(h.quantity * h.price, h.currency, b.base)), pnl: r2(toBase(h.quantity * (h.price - h.avgCost), h.currency, b.base)) }));
    const total = r2(b.cash + values.reduce((s, h) => s + h.value, 0));
    const conn = await prisma.brokerConnection.create({
      data: {
        userId,
        broker: b.broker,
        label: b.label,
        baseCurrency: b.base,
        cash: b.cash,
        totalValue: total,
        asOf: LAST,
        status: "OK",
        lastSyncAt: LAST,
        lastSyncMessage: "Demo data",
      },
    });
    const ref = { userId, connectionId: conn.id };
    holdingCount += values.length;
    await prisma.investmentHolding.createMany({
      data: values.map((h) => ({ ...ref, symbol: h.symbol, name: h.name, quantity: h.quantity, avgCost: h.avgCost, price: h.price, currency: h.currency, value: h.value, unrealisedPnl: h.pnl })),
    });
    // One opening buy per holding, a year ago; one partial sell of the first holding.
    await prisma.investmentTrade.createMany({
      data: [
        ...b.holdings.map((h, i) => ({ ...ref, externalId: `demo:${b.broker}:buy:${h.symbol}`, symbol: h.symbol, side: "BUY" as const, quantity: h.quantity, price: h.avgCost, fees: 1, currency: h.currency, executedAt: monthsAgo(11, 3 + i) })),
        { ...ref, externalId: `demo:${b.broker}:sell`, symbol: b.holdings[0].symbol, side: "SELL" as const, quantity: 1, price: b.holdings[0].price, fees: 1, currency: b.holdings[0].currency, executedAt: monthsAgo(2, 14) },
        { ...ref, externalId: `demo:${b.broker}:rebuy`, symbol: b.holdings[0].symbol, side: "BUY" as const, quantity: 1, price: b.holdings[0].price, fees: 1, currency: b.holdings[0].currency, executedAt: monthsAgo(1, 9) },
      ],
    });
    await prisma.investmentCashFlow.createMany({
      data: b.deposits.map((d) => ({ ...ref, externalId: `demo:${b.broker}:dep:${d.monthsAgo}`, date: monthsAgo(d.monthsAgo, 2), kind: "DEPOSIT" as const, amount: d.amount, currency: b.base, note: "Demo deposit" })),
    });
    // Dividends: paid on the 15th of each payout month over the last 12 months.
    const divs: { externalId: string; symbol: string; paidOn: Date; quantity: number; amount: number; withholdingTax: number | null; currency: string }[] = [];
    for (const [symbol, perShare, months] of b.payouts) {
      const h = b.holdings.find((x) => x.symbol === symbol)!;
      for (let n = 0; n < 12; n++) {
        const paid = monthsAgo(n, 15);
        if (paid > LAST || !months.includes(paid.getUTCMonth())) continue;
        const gross = toBase(h.quantity * perShare, h.currency, b.base);
        const tax = r2(gross * b.withholding);
        divs.push({ externalId: `demo:${b.broker}:div:${symbol}:${n}`, symbol, paidOn: paid, quantity: h.quantity, amount: r2(gross - tax), withholdingTax: tax || null, currency: b.base });
      }
    }
    await prisma.investmentDividend.createMany({ data: divs.map((d) => ({ ...ref, ...d })) });
    // Weekly value history over the year, growing toward today's total with a gentle wobble.
    const points: { date: Date; value: number }[] = [];
    for (let w = 52; w >= 1; w--) {
      const date = new Date(LAST.getTime() - w * 7 * 86_400_000);
      const t = (52 - w) / 52;
      points.push({ date, value: r2(total * (0.78 + 0.22 * t) * (1 + 0.025 * Math.sin(w / 3))) });
    }
    points.push({ date: LAST, value: total });
    await prisma.portfolioValue.createMany({ data: points.map((p) => ({ ...ref, date: p.date, value: p.value, currency: b.base })) });
  }

  for (let i = 0; i < 12; i++) {
    const end = new Date(Date.UTC(FIRST.getUTCFullYear(), FIRST.getUTCMonth() + i + 1, 0));
    if (end > LAST) break;
    await snapshotMonth(userId, end.toISOString().slice(0, 10), TODAY);
  }

  console.log(`Demo data: ${repaid.length} transactions, 5 accounts, 8 recurring rules, 3 goals, ${holdingCount} holdings for ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
