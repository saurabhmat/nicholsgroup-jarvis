import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

// shadcn/ui Input, on the provisional design tokens.
export type InputProps = ComponentProps<"input">;

export function Input({ className, type = "text", ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-control border border-border bg-card px-3 py-2 text-base text-foreground",
        "placeholder:text-muted-foreground outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
