export const PACKAGE_ID = "ui" as const;

export { cn, isSafeEmail, mailtoHref } from "./lib/utils";

export { Alert, AlertDescription, AlertTitle, alertVariants, type AlertProps } from "./components/alert";
export { Badge, badgeVariants, type BadgeProps } from "./components/badge";
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/card";
export { Input, type InputProps } from "./components/input";
export { Label, type LabelProps } from "./components/label";

export { BOOK_BALANCE_LABEL, BookBalance, BookBalanceLabel, type BookBalanceProps } from "./components/book-balance";
export { EmptyState, type EmptyStateProps } from "./components/empty-state";
export { ErrorBanner, type ErrorBannerProps } from "./components/error-banner";
export { ErrorState, type ErrorStateProps } from "./components/error-state";
export { KpiCard, type KpiCardProps, type KpiStatus } from "./components/kpi-card";
export { LaneChip, type LaneChipProps } from "./components/lane-chip";
export { FreshnessBadge, SourceChip, type Freshness, type SourceChipProps } from "./components/source-chip";

export { AppShell, type AppShellProps, type ShellBrand } from "./components/app-shell";
export { LaneSwitcher, type LaneSwitcherProps, type ShellLane, type ShellLink } from "./components/lane-switcher";
export { PageHeader, type PageHeaderProps } from "./components/page-header";
export { PageSection, type PageSectionProps } from "./components/page-section";
export { PERIODS, PeriodToggle, type PeriodKey, type PeriodToggleProps } from "./components/period-toggle";
export { TabIcon } from "./components/tab-icon";
export {
  activeKey,
  homeHeading,
  laneHref,
  MOBILE_TABS,
  MORE_ITEMS,
  NAV_ITEMS,
  navItem,
  onboardingEntry,
  pageHeading,
  type MobileTab,
  type NavItem,
  type NavKey,
  type OnboardingProgress,
  type TabIconName,
} from "./lib/nav";
export { applyTheme, readTheme, THEME_INIT, THEME_KEY, THEMES, type Theme } from "./lib/theme";
