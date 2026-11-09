import { cn } from "../lib/utils";

export type LaneChipProps = {
  /** Lane code, e.g. "PKG". */
  code: string;
  /** Optional company name; read by screen readers after the code. */
  name?: string;
  className?: string;
};

/** Identifies the lane (company) a view or figure belongs to. */
export function LaneChip({ code, name, className }: LaneChipProps) {
  return (
    <span
      data-slot="lane-chip"
      className={cn(
        "inline-flex w-fit items-center rounded-control border border-primary bg-primary-tint px-2 py-0.5 text-secondary font-semibold tracking-wide text-primary",
        className,
      )}
    >
      {code}
      {name ? <span className="sr-only"> {name}</span> : null}
    </span>
  );
}
