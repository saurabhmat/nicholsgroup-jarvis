import { ModuleGate } from "@/components/module-gate";
import { WeeklyPage, startWeekly } from "@/components/finance-weekly";

export default function Page(props: PageProps<"/[laneId]/finance/weekly">) {
  // T-276: the reads start beside the module gate; the page is rendered only after the gate answers.
  startWeekly(props.params, props.searchParams);
  return (
    <ModuleGate module="finance" params={props.params}>
      <WeeklyPage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
