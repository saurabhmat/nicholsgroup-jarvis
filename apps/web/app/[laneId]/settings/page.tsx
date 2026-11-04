import { Suspense } from "react";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/settings">) {
  return (
    <Suspense fallback={null}>
      <ModulePage module="settings" params={props.params} />
    </Suspense>
  );
}
