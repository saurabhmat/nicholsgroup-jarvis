import { ApprovalsPage } from "@/components/approvals-page";

export default function Page(props: PageProps<"/[laneId]/approvals">) {
  return (
    <ApprovalsPage params={props.params} />
  );
}
