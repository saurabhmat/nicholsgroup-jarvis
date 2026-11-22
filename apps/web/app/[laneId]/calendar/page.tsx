import { ModuleGate } from "@/components/module-gate";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/calendar">) {
  return (
    <ModuleGate module="calendar" params={props.params}>
      <ModulePage module="calendar" params={props.params} />
    </ModuleGate>
  );
}
