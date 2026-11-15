import { HomePage } from "@/components/home-page";

// Background work runs in after() of this page's server actions and shares this limit: the automatic summary (T-235: up to 5 Gmail
// reads and one model call, bounded at 75 s) and the GovCon news Refresh (T-249: one model call with web search, bounded at 240 s).
export const maxDuration = 300;

export default function Page(props: PageProps<"/[laneId]">) {
  return (
    <HomePage params={props.params} />
  );
}
