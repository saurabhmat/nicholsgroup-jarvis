import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/calendar">) {
  return (
    <ModulePage module="calendar" params={props.params} />
  );
}
