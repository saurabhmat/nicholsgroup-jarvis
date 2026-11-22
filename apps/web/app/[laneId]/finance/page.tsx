import { ModuleGate } from "@/components/module-gate";
import { FinancePage } from "@/components/finance-page";

export default function Page(props: PageProps<"/[laneId]/finance">) {
  return (
    <ModuleGate module="finance" params={props.params}>
      <FinancePage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
