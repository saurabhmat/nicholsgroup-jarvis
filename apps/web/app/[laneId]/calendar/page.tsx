import { ModuleGate } from "@/components/module-gate";
import { CalendarPage } from "@/components/calendar-page";

export default function Page(props: PageProps<"/[laneId]/calendar">) {
  return (
    <ModuleGate module="calendar" params={props.params}>
      <CalendarPage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
