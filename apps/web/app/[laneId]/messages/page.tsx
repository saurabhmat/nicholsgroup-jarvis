import { ShellModulePage } from "@/components/module-page";

// T-271: a placeholder page (lane check, header, "not set up yet"). It belongs to no module, so every company shows it.
export default function Page(props: PageProps<"/[laneId]/messages">) {
  return <ShellModulePage module="messages" params={props.params} />;
}
