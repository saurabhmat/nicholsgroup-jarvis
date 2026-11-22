import { ModuleGate } from "@/components/module-gate";
import { InboxPage } from "@/components/inbox-page";

export default function Page(props: PageProps<"/[laneId]/inbox">) {
  return (
    <ModuleGate module="comms" params={props.params}>
      <InboxPage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
