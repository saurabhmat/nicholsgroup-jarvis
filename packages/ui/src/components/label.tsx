import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

// shadcn/ui Label (native <label>; no radix dependency).
export type LabelProps = ComponentProps<"label">;

export function Label({ className, ...props }: LabelProps) {
  return <label data-slot="label" className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}
