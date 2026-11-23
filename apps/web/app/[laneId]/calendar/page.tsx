import { ModuleGate } from "@/components/module-gate";
import { CalendarPage, startCalendar } from "@/components/calendar-page";

export default function Page(props: PageProps<"/[laneId]/calendar">) {
  // T-276: the calendar read starts beside the module gate; the page below is still rendered only after the gate answers.
  startCalendar(props.params, props.searchParams);
  return (
    <ModuleGate module="calendar" params={props.params}>
      <CalendarPage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
