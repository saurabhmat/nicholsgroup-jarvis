import { HomePage } from "@/components/home-page";

// "Run now" (T-231c) runs inside this page's server-action request: up to 5 Gmail reads and one model call.
export const maxDuration = 90;

export default function Page(props: PageProps<"/[laneId]">) {
  return (
    <HomePage params={props.params} />
  );
}
