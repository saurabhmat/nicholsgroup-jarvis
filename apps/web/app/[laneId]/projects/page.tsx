import { ModuleGate } from "@/components/module-gate";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/projects">) {
  return (
    <ModuleGate module="projects" params={props.params}>
      <ModulePage module="projects" params={props.params} />
    </ModuleGate>
  );
}
