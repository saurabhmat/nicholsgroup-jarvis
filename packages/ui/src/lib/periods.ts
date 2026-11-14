// The finance periods (T-245). A plain module with no "use client" / "use server" directive: constants exported from a
// directive file reach server components as a reference, not a value (production crash `PERIODS.map is not a function`).
export const PERIODS = [
  { key: "week", label: "This week (Sat–Fri)" },
  { key: "mtd", label: "Month to date" },
  { key: "ytd", label: "Year to date" },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];
