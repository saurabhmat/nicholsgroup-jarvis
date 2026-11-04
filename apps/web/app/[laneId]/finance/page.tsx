import { Suspense } from "react";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/finance">) {
  return (
    <Suspense fallback={null}>
      <ModulePage module="finance" params={props.params} />
    </Suspense>
  );
}
