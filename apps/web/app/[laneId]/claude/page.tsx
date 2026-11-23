import { ExternalChatPage } from "@/components/external-chat-page";

export default function Page(props: PageProps<"/[laneId]/claude">) {
  return <ExternalChatPage chat="claude" params={props.params} />;
}
