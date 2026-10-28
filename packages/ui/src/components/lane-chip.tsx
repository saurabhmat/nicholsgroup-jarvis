import { cn } from "../lib/utils";

export type LaneChipProps = {
  /** Lane code, e.g. "PKG". */
  code: string;
  /** Optional company name; shown as a tooltip and read by screen readers. */
  name?: string;
  className?: string;
};

/** Identifies the lane (company) a view or figure belongs to. */
export function LaneChip({ code, name, className }: LaneChipProps) {
  return (
    <span
      data-slot="lane-chip"
      title={name}
      className={cn(
        "inline-flex w-fit items-center rounded-control border border-primary bg-primary-tint px-2 py-0.5 text-xs font-semibold tracking-wide text-primary",
        className,
      )}
    >
      {code}
      {name ? <span className="sr-only"> {name}</span> : null}
    </span>
  );
}
