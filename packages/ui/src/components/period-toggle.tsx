"use client";
import { useState } from "react";
import { cn } from "../lib/utils";

export const PERIODS = [
  { key: "week", label: "This week (Sat–Fri)" },
  { key: "mtd", label: "Month to date" },
  { key: "ytd", label: "Year to date" },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];

export type PeriodToggleProps = {
  defaultPeriod?: PeriodKey;
  /** Called when the choice changes. Until figures exist this is UI state only. */
  onChange?: (period: PeriodKey) => void;
};

/** Finance period toggle: This week (Sat–Fri) / Month to date / Year to date. */
export function PeriodToggle({ defaultPeriod = "mtd", onChange }: PeriodToggleProps) {
  const [period, setPeriod] = useState<PeriodKey>(defaultPeriod);
  return (
    <div role="group" aria-label="Period" data-slot="period-toggle" className="inline-flex overflow-hidden rounded-control border border-border bg-card">
      {PERIODS.map((p) => (
        <button
          key={p.key}
          type="button"
          aria-pressed={period === p.key}
          onClick={() => {
            setPeriod(p.key);
            onChange?.(p.key);
          }}
          className={cn(
            "px-3 py-2 text-sm",
            period === p.key ? "bg-primary font-semibold text-primary-foreground" : "text-foreground hover:bg-accent",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
