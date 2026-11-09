import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { activeKey, laneHref, MOBILE_TABS, NAV_ITEMS, onboardingEntry, pageHeading, type OnboardingProgress } from "../lib/nav";
import { Badge } from "./badge";
import { TabIcon } from "./tab-icon";
import { LaneSwitcher, type ShellLane, type ShellLink } from "./lane-switcher";

export type ShellBrand = { wordmark: string; product: string };

export type AppShellProps = {
  brand: ShellBrand;
  lanes: readonly ShellLane[];
  currentLaneId: string;
  /** Current URL path, for the selected menu entry. */
  pathname: string;
  /** Pending approvals in the SELECTED lane only; the badge is hidden at 0 or when unknown. */
  approvalsCount?: number;
  /** Setup progress for the "Get started" entry; omitted (null) for users without the brain view: the entry is not drawn. */
  onboarding?: OnboardingProgress | null;
  /** First name for the Home title on the iPhone header band; omitted when unknown. */
  firstName?: string;
  /** Form action that signs the user out. */
  signOut: (formData: FormData) => void | Promise<void>;
  /** Optional control above Sign out in the side menu (the theme toggle). */
  menuExtra?: ReactNode;
  Link?: ShellLink;
  children: ReactNode;
};

const DefaultLink: ShellLink = (props) => <a {...props} />;

function Star({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={cn("size-4 fill-gold", className)}>
      <path d="M12 2l2.9 6.6 7.1.7-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.3l7.1-.7z" />
    </svg>
  );
}

function Check() {
  return (
    <svg aria-label="Setup complete" role="img" viewBox="0 0 24 24" className="size-4 fill-none stroke-gold stroke-2">
      <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CountBadge({ count, className }: { count?: number; className?: string }) {
  if (!count || count < 1) return null;
  return (
    <Badge variant="gold" className={className ?? "ml-auto"} aria-label={`${String(count)} pending`}>
      {count > 99 ? "99+" : count}
    </Badge>
  );
}

/**
 * The authenticated layout (D-20 batch 1): navy side menu on desktop; navy header band with the company switcher and
 * bottom tabs on iPhone. Presentational only: the app decides what the user may see and passes the lanes in.
 * Light theme, colours from the T-022 tokens only.
 */
export function AppShell({ brand, lanes, currentLaneId, pathname, approvalsCount, onboarding, firstName, signOut, menuExtra, Link = DefaultLink, children }: AppShellProps) {
  const active = activeKey(currentLaneId, pathname);
  const heading = pageHeading(active, firstName);
  const segment = NAV_ITEMS.find((i) => i.key === active)?.segment ?? "";
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      {/* Desktop side menu */}
      <aside data-slot="side-menu" className="hidden w-60 shrink-0 flex-col gap-4 bg-sidebar p-4 text-sidebar-foreground md:flex">
        <div>
          <p className="flex items-center gap-2 font-heading text-xl font-semibold text-sidebar-strong">
            {brand.wordmark}
            <Star />
          </p>
          <p className="text-xs text-sidebar-section">{brand.product}</p>
        </div>
        <LaneSwitcher lanes={lanes} currentLaneId={currentLaneId} segment={segment} Link={Link} />
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {NAV_ITEMS.filter((item) => item.key !== "onboarding" || onboarding).map((item) => {
            const selected = item.key === active;
            const entry = item.key === "onboarding" && onboarding ? onboardingEntry(onboarding) : null;
            return (
              <Link
                key={item.key}
                href={laneHref(currentLaneId, item.segment)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-control border-l-[3px] px-3 py-2 text-sm hover:bg-sidebar-switcher",
                  selected ? "border-sidebar-active-edge bg-sidebar-active font-semibold text-sidebar-strong" : "border-transparent",
                )}
              >
                {entry ? entry.label : item.label}
                {entry?.complete ? <Check /> : null}
                {entry?.badge ? (
                  <Badge variant="gold" className="ml-auto" data-testid="onboarding-badge">
                    {entry.badge}
                  </Badge>
                ) : null}
                {item.key === "approvals" ? <CountBadge count={approvalsCount} /> : null}
              </Link>
            );
          })}
        </nav>
        {menuExtra}
        <form action={signOut}>
          <button
            type="submit"
            className="w-full rounded-control border border-sidebar-switcher-border px-3 py-2 text-left text-sm hover:bg-sidebar-switcher"
          >
            Sign out
          </button>
        </form>
      </aside>

      {/* iPhone header band */}
      <header data-slot="mobile-header" className="flex flex-col gap-3 bg-sidebar px-4 pb-4 pt-3 text-sidebar-foreground md:hidden">
        <LaneSwitcher lanes={lanes} currentLaneId={currentLaneId} segment={segment} Link={Link} chip />
        {/* Visual title only: the page's own h1 stays in the accessibility tree. */}
        <p aria-hidden="true" data-slot="mobile-title" className="font-heading text-2xl font-semibold text-sidebar-strong">
          {heading.lead}
          {heading.accent ? (
            <>
              {" "}
              <em className="font-normal italic text-gold">{heading.accent}</em>
            </>
          ) : null}
        </p>
      </header>

      <main id="content" className="w-full min-w-0 max-w-content flex-1 p-4 pb-24 md:px-8 md:py-8">
        {children}
      </main>

      {/* iPhone bottom tabs: no back link on tab pages */}
      <nav
        aria-label="Tabs"
        data-slot="tab-bar"
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {MOBILE_TABS.map((tab) => {
          const selected = active === tab.key || (active !== null && active !== "more" && tab.covers.includes(active)) || (tab.key === "more" && active === "more");
          return (
            <Link
              key={tab.key}
              href={laneHref(currentLaneId, tab.segment)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 border-t-[3px] py-2 text-xs",
                selected ? "border-gold font-semibold text-primary" : "border-transparent text-muted-foreground",
              )}
            >
              <TabIcon name={tab.icon} />
              {tab.label}
              {tab.key === "approvals" ? <CountBadge count={approvalsCount} className="absolute right-3 top-1" /> : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
