import { AssistantPage } from "@/components/assistant-page";

export default function Page(props: PageProps<"/[laneId]/assistant">) {
  return (
    <AssistantPage params={props.params} />
  );
}
