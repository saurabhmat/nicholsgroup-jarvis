import { ModuleGate } from "@/components/module-gate";
import { MessagesPage, startMessages } from "@/components/messages-page";

// T-280, T-283: the `messages` module gate (a limited company shows Messages only when it lists the module), then the Teams connect states and the connected person's chats. The connect
// state is read beside the gate (T-276); the page below, and with it every read of Microsoft, is rendered only after the gate answers. The address `?chat=<key>` (and `?more=<cursor>`) is read
// inside the page's Suspense, never here, so this function stays synchronous and prefetchable.
export default function Page(props: PageProps<"/[laneId]/messages">) {
  startMessages(props.params);
  return (
    <ModuleGate module="messages" params={props.params}>
      <MessagesPage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
