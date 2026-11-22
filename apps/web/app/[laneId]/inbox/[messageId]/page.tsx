import { ModuleGate } from "@/components/module-gate";
import { MessagePage } from "@/components/message-page";

export default function Page(props: PageProps<"/[laneId]/inbox/[messageId]">) {
  return (
    <ModuleGate module="comms" params={props.params}>
      <MessagePage params={props.params} />
    </ModuleGate>
  );
}
