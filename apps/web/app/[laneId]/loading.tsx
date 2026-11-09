// T-230 A: shown at once while a page under /[laneId] loads (the layout and menu stay). Every segment below has its own
// loading.tsx re-exporting this one: a boundary exists per segment, so switching between pages shows it on every click.
import { PageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <PageSkeleton />;
}
