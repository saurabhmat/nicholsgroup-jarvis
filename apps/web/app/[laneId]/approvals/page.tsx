import { ModuleGate } from "@/components/module-gate";
import { ApprovalsPage } from "@/components/approvals-page";

export default function Page(props: PageProps<"/[laneId]/approvals">) {
  return (
    <ModuleGate module="approvals" params={props.params}>
      <ApprovalsPage params={props.params} />
    </ModuleGate>
  );
}
