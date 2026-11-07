import { Suspense } from "react";
import { MessagePage } from "@/components/message-page";

export default function Page(props: PageProps<"/[laneId]/inbox/[messageId]">) {
  return (
    <Suspense fallback={null}>
      <MessagePage params={props.params} />
    </Suspense>
  );
}
