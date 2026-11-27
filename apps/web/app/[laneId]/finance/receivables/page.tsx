import { ModuleGate } from "@/components/module-gate";
import { ReceivablesPage, startReceivables } from "@/components/finance-receivables";

export default function Page(props: PageProps<"/[laneId]/finance/receivables">) {
  // T-276: the read starts beside the module gate; the page is rendered only after the gate answers.
  startReceivables(props.params);
  return (
    <ModuleGate module="finance" params={props.params}>
      <ReceivablesPage params={props.params} />
    </ModuleGate>
  );
}
