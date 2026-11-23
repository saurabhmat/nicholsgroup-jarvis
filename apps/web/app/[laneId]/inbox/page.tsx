import { ModuleGate } from "@/components/module-gate";
import { InboxPage, startInbox } from "@/components/inbox-page";

export default function Page(props: PageProps<"/[laneId]/inbox">) {
  // T-276: the mail reads start beside the module gate; the page below is still rendered only after the gate answers.
  startInbox(props.params, props.searchParams);
  return (
    <ModuleGate module="comms" params={props.params}>
      <InboxPage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
