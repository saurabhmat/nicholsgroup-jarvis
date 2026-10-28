export const PACKAGE_ID = "ui" as const;

export { cn, isSafeEmail, mailtoHref } from "./lib/utils";

export { Alert, AlertDescription, AlertTitle, alertVariants, type AlertProps } from "./components/alert";
export { Badge, badgeVariants, type BadgeProps } from "./components/badge";
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/card";

export { BOOK_BALANCE_LABEL, BookBalance, BookBalanceLabel, type BookBalanceProps } from "./components/book-balance";
export { EmptyState, type EmptyStateProps } from "./components/empty-state";
export { ErrorBanner, type ErrorBannerProps } from "./components/error-banner";
export { ErrorState, type ErrorStateProps } from "./components/error-state";
export { KpiCard, type KpiCardProps, type KpiStatus } from "./components/kpi-card";
export { LaneChip, type LaneChipProps } from "./components/lane-chip";
export { FreshnessBadge, SourceChip, type Freshness, type SourceChipProps } from "./components/source-chip";
