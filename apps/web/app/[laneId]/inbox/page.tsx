import { Suspense } from "react";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/inbox">) {
  return (
    <Suspense fallback={null}>
      <ModulePage module="inbox" params={props.params} />
    </Suspense>
  );
}
