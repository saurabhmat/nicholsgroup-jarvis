// T-230: the setup-shaped skeleton (see ../loading.tsx: a boundary per segment shows it on every click).
import { PageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return <PageSkeleton variant="setup" />;
}
