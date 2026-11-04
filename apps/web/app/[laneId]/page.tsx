import { Suspense } from "react";
import { HomePage } from "@/components/home-page";

export default function Page(props: PageProps<"/[laneId]">) {
  return (
    <Suspense fallback={null}>
      <HomePage params={props.params} />
    </Suspense>
  );
}
