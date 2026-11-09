import { HomePage } from "@/components/home-page";

export default function Page(props: PageProps<"/[laneId]">) {
  return (
    <HomePage params={props.params} />
  );
}
