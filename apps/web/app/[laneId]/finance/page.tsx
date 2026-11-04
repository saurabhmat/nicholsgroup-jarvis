import { Suspense } from "react";
import { FinancePage } from "@/components/finance-page";

export default function Page(props: PageProps<"/[laneId]/finance">) {
  return (
    <Suspense fallback={null}>
      <FinancePage params={props.params} />
    </Suspense>
  );
}
