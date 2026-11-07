import { Suspense } from "react";
import { InboxPage } from "@/components/inbox-page";

export default function Page(props: PageProps<"/[laneId]/inbox">) {
  return (
    <Suspense fallback={null}>
      <InboxPage params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}
