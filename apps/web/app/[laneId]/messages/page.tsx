import { ModuleGate } from "@/components/module-gate";
import { MessagesPage, startMessages } from "@/components/messages-page";

// T-280: the `messages` module gate (a limited company shows Messages only when it lists the module), then the Teams connect states. The connect state is read beside the gate (T-276);
// the page below is still rendered only after the gate answers.
export default function Page(props: PageProps<"/[laneId]/messages">) {
  startMessages(props.params);
  return (
    <ModuleGate module="messages" params={props.params}>
      <MessagesPage params={props.params} />
    </ModuleGate>
  );
}
