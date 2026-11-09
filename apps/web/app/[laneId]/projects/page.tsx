import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/projects">) {
  return (
    <ModulePage module="projects" params={props.params} />
  );
}
