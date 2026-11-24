import { ModuleGate } from "@/components/module-gate";
import { MessagesPage } from "@/components/messages-page";

// T-280, T-283, T-296: the `messages` module gate (a limited company shows Messages only when it lists the module), then the conversation side of the Messages screen (the header, the connect states and the
// chat list are the layout's, layout.tsx; the connect state is read beside the gate, T-276). The page below, and with it every read of Microsoft for the open conversation or the Channels tab, is rendered
// only after the gate answers. The address (`?conn=`, `?chat=`, `?tab=` ...) is read inside the page's Suspense, never here, so this function stays synchronous and prefetchable.
export default function Page(props: PageProps<"/[laneId]/messages">) {
  return (
    <ModuleGate module="messages" params={props.params}>
      <MessagesPage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
