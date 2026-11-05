import { Suspense } from "react";
import { SettingsPage } from "@/components/settings-page";

export default function Page(props: PageProps<"/[laneId]/settings">) {
  return (
    <Suspense fallback={null}>
      <SettingsPage params={props.params} />
    </Suspense>
  );
}
