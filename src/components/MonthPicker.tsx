"use client";

import { useRouter } from "next/navigation";

const YEARS = [2025, 2026, 2027, 2028, 2029, 2030];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Year + month dropdowns that navigate to `${basePath}?month=YYYY-MM`.
 * `value` is the current "YYYY-MM".
 */
export function MonthPicker({
  value,
  basePath,
  extraQuery,
}: {
  value: string;
  basePath: string;
  /** Extra query string to keep on navigation, e.g. "scope=business". */
  extraQuery?: string;
}) {
  const router = useRouter();
  const [y, m] = value.split("-");

  function go(year: string, month: string) {
    const extra = extraQuery ? `&${extraQuery}` : "";
    router.push(`${basePath}?month=${year}-${month}${extra}`);
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={m}
        onChange={(e) => go(y, e.target.value)}
        className="input-field w-auto py-2"
        aria-label="Month"
      >
        {MONTHS.map((name, i) => {
          const mm = String(i + 1).padStart(2, "0");
          return (
            <option key={mm} value={mm}>
              {name}
            </option>
          );
        })}
      </select>
      <select
        value={y}
        onChange={(e) => go(e.target.value, m)}
        className="input-field w-auto py-2"
        aria-label="Year"
      >
        {YEARS.map((yr) => (
          <option key={yr} value={String(yr)}>
            {yr}
          </option>
        ))}
      </select>
    </div>
  );
}
