import { Suspense } from "react";
import { ApprovalsPage } from "@/components/approvals-page";

export default function Page(props: PageProps<"/[laneId]/approvals">) {
  return (
    <Suspense fallback={null}>
      <ApprovalsPage params={props.params} />
    </Suspense>
  );
}
