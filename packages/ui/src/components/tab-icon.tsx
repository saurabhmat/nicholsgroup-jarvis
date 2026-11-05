import { cn } from "../lib/utils";
import type { TabIconName } from "../lib/nav";

const PATHS: Record<TabIconName, string[]> = {
  home: ["M3 11l9-8 9 8", "M5 10v10h14V10", "M10 20v-6h4v6"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  mail: ["M3 6h18v12H3z", "M3 7l9 7 9-7"],
  chat: ["M20 11.5A7.5 7.5 0 0 1 8.5 18L4 19.5 5.5 15.5A7.5 7.5 0 1 1 20 11.5z"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
};

/** Inline line icon for the iPhone tabs (no icon dependency). Decorative: hidden from assistive tech; the label stays. */
export function TabIcon({ name, className }: { name: TabIconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-5", className)}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
