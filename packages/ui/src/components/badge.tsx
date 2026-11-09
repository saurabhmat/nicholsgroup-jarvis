import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

// shadcn/ui Badge. Every variant pairs a text and ground token checked for 4.5:1 contrast.
export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-control border px-2 py-0.5 text-small font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-primary-tint text-primary",
        outline: "border-border bg-card text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        success: "border-transparent bg-success-surface text-success",
        alert: "border-transparent bg-alert-surface text-alert-foreground",
        gold: "border-gold bg-card text-gold-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
