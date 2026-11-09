import { MessagePage } from "@/components/message-page";

export default function Page(props: PageProps<"/[laneId]/inbox/[messageId]">) {
  return (
    <MessagePage params={props.params} />
  );
}
