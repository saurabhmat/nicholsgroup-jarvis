import { SettingsPage } from "@/components/settings-page";

export default function Page(props: PageProps<"/[laneId]/settings">) {
  return (
    <SettingsPage params={props.params} searchParams={props.searchParams} />
  );
}
