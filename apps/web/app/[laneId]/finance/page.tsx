import { FinancePage } from "@/components/finance-page";

export default function Page(props: PageProps<"/[laneId]/finance">) {
  return (
    <FinancePage params={props.params} />
  );
}
