import { describe, expect, it } from "vitest";
import { ECB_DAILY_URL, ECB_HIST_90D_URL, parseEcbXml } from "@/lib/ecb";

// The one ECB parser shared by `scripts/update-fx.mjs` and `POST /api/fx/update`
// (fx.ts re-exports it). Real feed shape, trimmed.

const DAILY = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<gesmes:Sender>
		<gesmes:name>European Central Bank</gesmes:name>
	</gesmes:Sender>
	<Cube>
		<Cube time='2026-09-18'>
			<Cube currency='USD' rate='1.1481'/>
			<Cube currency='JPY' rate='169.62'/>
			<Cube currency='SEK' rate='11.2715'/>
			<Cube currency='GBP' rate='0.86580'/>
			<Cube currency='CHF' rate='0.9311'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;

const HIST = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<Cube>
		<Cube time="2026-09-18">
			<Cube currency="USD" rate="1.1481"/>
			<Cube currency="GBP" rate="0.86580"/>
		</Cube>
		<Cube time="2026-09-17">
			<Cube currency="USD" rate="1.1790"/>
			<Cube currency="GBP" rate="0.86700"/>
		</Cube>
		<Cube time="2026-09-15">
			<Cube currency="USD" rate="1.1750"/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;

describe("parseEcbXml — daily feed", () => {
  it("returns one row per currency, dated with the fixing day, rate as a number", () => {
    const rates = parseEcbXml(DAILY);
    expect(rates).toHaveLength(5);
    expect(rates.every((r) => r.date === "2026-09-18")).toBe(true);
    expect(rates.find((r) => r.currency === "USD")).toEqual({ currency: "USD", date: "2026-09-18", perEur: 1.1481 });
    expect(rates.find((r) => r.currency === "GBP")?.perEur).toBe(0.8658);
    expect(rates.find((r) => r.currency === "JPY")?.perEur).toBe(169.62);
  });

  it("a currency the ECB does not publish is simply absent", () => {
    const rates = parseEcbXml(DAILY);
    expect(rates.find((r) => r.currency === "XYZ")).toBeUndefined();
    expect(rates.some((r) => r.currency === "EUR")).toBe(false);
  });

  it("accepts single- or double-quoted attributes and extra whitespace", () => {
    const xml = `<Cube><Cube   time="2026-01-02" >
      <Cube currency='USD' rate="1.05" />
      <Cube currency="GBP"   rate='0.85'/>
    </Cube></Cube>`;
    expect(parseEcbXml(xml)).toEqual([
      { currency: "USD", date: "2026-01-02", perEur: 1.05 },
      { currency: "GBP", date: "2026-01-02", perEur: 0.85 },
    ]);
  });
});

describe("parseEcbXml — 90-day history", () => {
  it("returns every (date, currency) pair across all fixing days; weekends simply have no day", () => {
    const rates = parseEcbXml(HIST);
    expect(rates).toHaveLength(5);
    expect([...new Set(rates.map((r) => r.date))].sort()).toEqual(["2026-09-15", "2026-09-17", "2026-09-18"]);
    expect(rates.filter((r) => r.currency === "USD").map((r) => [r.date, r.perEur])).toEqual([
      ["2026-09-18", 1.1481],
      ["2026-09-17", 1.179],
      ["2026-09-15", 1.175],
    ]);
    expect(rates.filter((r) => r.currency === "GBP")).toHaveLength(2);
  });
});

describe("parseEcbXml — bad input", () => {
  it("throws on a document with no fixing (HTML error page, truncated download, empty string)", () => {
    expect(() => parseEcbXml("")).toThrow(/no rates/);
    expect(() => parseEcbXml("<html><body>503 Service Unavailable</body></html>")).toThrow(/no rates/);
    expect(() => parseEcbXml(`<Cube><Cube time="2026-09-18"><Cube currency="USD" rate="1.14`)).toThrow(/no rates/);
  });

  it("throws when the day block exists but holds no usable rate", () => {
    expect(() => parseEcbXml(`<Cube><Cube time="2026-09-18"></Cube></Cube>`)).toThrow(/no rates/);
  });

  it("skips malformed rows (non-numeric, zero, lower-case code, bad date) and keeps the good ones", () => {
    const xml = `<Cube>
      <Cube time="2026-09-18">
        <Cube currency="USD" rate="N/A"/>
        <Cube currency="JPY" rate="0"/>
        <Cube currency="usd" rate="1.1"/>
        <Cube currency="GBPX" rate="0.86"/>
        <Cube currency="CHF" rate="0.93"/>
      </Cube>
      <Cube time="18/09/2026">
        <Cube currency="USD" rate="1.2"/>
      </Cube>
    </Cube>`;
    expect(parseEcbXml(xml)).toEqual([{ currency: "CHF", date: "2026-09-18", perEur: 0.93 }]);
  });
});

describe("feed URLs", () => {
  it("point at the ECB's public daily and 90-day documents over https", () => {
    expect(ECB_DAILY_URL).toBe("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    expect(ECB_HIST_90D_URL).toBe("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml");
  });
});

// ─── F8: staleness maths (pure) ──────────────────────────────────────
import { businessDaysSince, easterSunday, isTargetBusinessDay, refreshModeFor, targetHolidays } from "@/lib/ecb";

describe("TARGET calendar", () => {
  it("computes Easter Sunday", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2025)).toBe("2025-04-20");
  });
  it("lists the six closing days", () => {
    expect([...targetHolidays(2026)].sort()).toEqual([
      "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "2026-12-25", "2026-12-26",
    ]);
  });
  it("treats weekends and holidays as non-business days", () => {
    expect(isTargetBusinessDay("2026-10-17")).toBe(false); // Saturday
    expect(isTargetBusinessDay("2026-10-18")).toBe(false); // Sunday
    expect(isTargetBusinessDay("2026-04-03")).toBe(false); // Good Friday
    expect(isTargetBusinessDay("2026-10-16")).toBe(true);
  });
});

describe("businessDaysSince", () => {
  it("is 0 on the same day and over a plain weekend", () => {
    expect(businessDaysSince("2026-10-16", "2026-10-16")).toBe(0);
    expect(businessDaysSince("2026-10-16", "2026-10-18")).toBe(0); // Fri → Sun
  });
  it("counts the weekdays after the last fixing", () => {
    expect(businessDaysSince("2026-10-16", "2026-10-19")).toBe(1);
    expect(businessDaysSince("2026-10-09", "2026-10-16")).toBe(5);
  });
  it("skips Easter and Christmas", () => {
    expect(businessDaysSince("2026-04-02", "2026-04-07")).toBe(1); // Good Fri + Easter Mon off
    expect(businessDaysSince("2026-12-24", "2026-12-28")).toBe(1);
  });
});

describe("refreshModeFor", () => {
  it("does nothing up to 3 business days, daily for 4–5, history beyond", () => {
    expect(refreshModeFor(0)).toBeNull();
    expect(refreshModeFor(3)).toBeNull();
    expect(refreshModeFor(4)).toBe("daily");
    expect(refreshModeFor(5)).toBe("daily");
    expect(refreshModeFor(6)).toBe("hist90");
    expect(refreshModeFor(Number.POSITIVE_INFINITY)).toBe("hist90");
  });
});
