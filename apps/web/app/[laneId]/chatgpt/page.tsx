import { ExternalChatPage } from "@/components/external-chat-page";

export default function Page(props: PageProps<"/[laneId]/chatgpt">) {
  return <ExternalChatPage chat="chatgpt" params={props.params} />;
}
