import { Suspense } from "react";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/approvals">) {
  return (
    <Suspense fallback={null}>
      <ModulePage module="approvals" params={props.params} />
    </Suspense>
  );
}
