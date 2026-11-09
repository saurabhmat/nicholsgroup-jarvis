import { InboxPage } from "@/components/inbox-page";

export default function Page(props: PageProps<"/[laneId]/inbox">) {
  return (
    <InboxPage params={props.params} searchParams={props.searchParams} />
  );
}
