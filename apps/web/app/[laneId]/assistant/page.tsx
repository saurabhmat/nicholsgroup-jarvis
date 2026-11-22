import { ModuleGate } from "@/components/module-gate";
import { AssistantPage } from "@/components/assistant-page";

export default function Page(props: PageProps<"/[laneId]/assistant">) {
  return (
    <ModuleGate module="assistant" params={props.params}>
      <AssistantPage params={props.params} />
    </ModuleGate>
  );
}
