import { PageSkeleton } from "./page-skeleton";

/**
 * T-276: what a typed address or a reload shows while the shell's reads finish (it used to be nothing at all). Static and data-free: no params, cookies,
 * headers or clock, so it is part of the prerendered shell. The side menu's column (same width and colour as the real one, from md) and the same
 * skeleton the pages use; the real shell replaces it when the lane check answers.
 */
export function ShellFallback() {
  return (
    <div data-testid="shell-fallback" className="flex min-h-dvh flex-col md:flex-row">
      <div aria-hidden data-slot="side-menu-fallback" className="hidden w-60 min-w-60 shrink-0 bg-sidebar md:block" />
      <div className="w-full min-w-0 max-w-content flex-1 p-4 pb-24 md:px-8 md:py-8">
        <PageSkeleton />
      </div>
    </div>
  );
}
