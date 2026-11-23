import { ModuleGate } from "@/components/module-gate";
import { FinancePage, startFinance } from "@/components/finance-page";

export default function Page(props: PageProps<"/[laneId]/finance">) {
  // T-276: the finance reads start beside the module gate; the page below is still rendered only after the gate answers.
  startFinance(props.params, props.searchParams);
  return (
    <ModuleGate module="finance" params={props.params}>
      <FinancePage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
