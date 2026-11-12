import { HomePage } from "@/components/home-page";

// The automatic summary (T-235) runs in after() of this page's server action: up to 5 Gmail reads and one model call, bounded at 75 s.
export const maxDuration = 90;

export default function Page(props: PageProps<"/[laneId]">) {
  return (
    <HomePage params={props.params} />
  );
}
