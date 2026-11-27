import { ModuleGate } from "@/components/module-gate";
import { CashPage, startCash } from "@/components/finance-cash";

export default function Page(props: PageProps<"/[laneId]/finance/cash">) {
  // T-276: the read starts beside the module gate; the page is rendered only after the gate answers.
  startCash(props.params);
  return (
    <ModuleGate module="finance" params={props.params}>
      <CashPage params={props.params} />
    </ModuleGate>
  );
}
