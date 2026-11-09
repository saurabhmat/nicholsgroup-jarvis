// T-230: the list-shaped skeleton (see ../loading.tsx: a boundary per segment shows it on every click).
import { PageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <PageSkeleton variant="list" />;
}
