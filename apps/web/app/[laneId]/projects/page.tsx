import { Suspense } from "react";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/projects">) {
  return (
    <Suspense fallback={null}>
      <ModulePage module="projects" params={props.params} />
    </Suspense>
  );
}
