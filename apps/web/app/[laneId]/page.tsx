import { Suspense } from "react";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]">) {
  return (
    <Suspense fallback={null}>
      <ModulePage module="home" params={props.params} />
    </Suspense>
  );
}
