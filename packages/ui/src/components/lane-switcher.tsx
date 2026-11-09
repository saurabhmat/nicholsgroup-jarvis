import type { ComponentProps, ComponentType } from "react";
import { cn } from "../lib/utils";
import { laneHref } from "../lib/nav";

/** The link element the app supplies (Next's `Link`); a plain anchor by default. */
export type ShellLink = ComponentType<ComponentProps<"a"> & { href: string }>;

export type ShellLane = { laneId: string; name: string };

export type LaneSwitcherProps = {
  /** The lanes the user may open (already filtered on the server: enabled and allowed). No "all companies" option. */
  lanes: readonly ShellLane[];
  currentLaneId: string;
  /** Path segment inside the lane to keep when switching ("" = home). */
  segment?: string;
  Link?: ShellLink;
  className?: string;
  /** iPhone header band: a compact rounded chip instead of the full-width box. */
  chip?: boolean;
};

const DefaultLink: ShellLink = (props) => <a {...props} />;

/**
 * Company switcher for the navy side menu and the iPhone header band. With one lane it is a static label; with
 * several it is a disclosure list of links (works without JavaScript). The URL carries the lane; the server checks
 * it again on every page, so this list is a convenience and never the gate.
 */
export function LaneSwitcher({ lanes, currentLaneId, segment = "", Link = DefaultLink, className, chip = false }: LaneSwitcherProps) {
  const current = lanes.find((l) => l.laneId === currentLaneId);
  const box = chip
    ? "inline-block max-w-full rounded-full border border-sidebar-switcher-border bg-sidebar-active min-h-11 px-3 py-2.5 text-left text-sm font-semibold text-sidebar-strong"
    : "w-full rounded-control border border-sidebar-switcher-border bg-sidebar-switcher px-3 py-2 text-left text-sm font-medium text-sidebar-strong";
  if (lanes.length <= 1) {
    return (
      <div data-slot="lane-switcher" className={cn(box, className)}>
        <span className="sr-only">Company: </span>
        {current?.name ?? currentLaneId}
      </div>
    );
  }
  return (
    <details data-slot="lane-switcher" className={cn("relative", chip && "w-fit max-w-full", className)}>
      <summary className={cn(box, "cursor-pointer list-none")}>
        <span className="sr-only">Company: </span>
        {current?.name ?? currentLaneId}
      </summary>
      <ul className="absolute z-20 mt-1 w-full min-w-48 rounded-control border border-border bg-popover p-1 text-popover-foreground shadow-md">
        {lanes.map((l) => (
          <li key={l.laneId}>
            <Link
              href={laneHref(l.laneId, segment)}
              aria-current={l.laneId === currentLaneId ? "true" : undefined}
              className="block rounded-control px-3 py-2 text-sm hover:bg-accent aria-[current=true]:font-semibold"
            >
              {l.name}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
