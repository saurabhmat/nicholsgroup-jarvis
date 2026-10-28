import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

// shadcn/ui Card, styled with the theme tokens.

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-card border border-border bg-card p-5 text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1", className)} {...props} />;
}

export type CardTitleProps = ComponentProps<"h3"> & {
  /** Heading level for the page outline; defaults to h3. */
  as?: "h2" | "h3" | "h4";
};

export function CardTitle({ as: Heading = "h3", className, ...props }: CardTitleProps) {
  return (
    <Heading data-slot="card-title" className={cn("text-base font-semibold leading-tight", className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn(className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex flex-wrap items-center gap-2 border-t border-divider pt-3", className)}
      {...props}
    />
  );
}
