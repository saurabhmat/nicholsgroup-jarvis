// Where a user lands after finishing sign-in (T-023). A server-action redirect to "/" would render the first lane under
// the "/" URL (the entry page redirects while streaming, and client navigation keeps the old address), so the actions
// resolve the first allowed lane themselves. The lane list comes from the server-side guards, never from the URL.
import "server-only";
import { guards } from "@/lib/guards";

export async function landingPath(next: string): Promise<string> {
  // Only the entry page ("/", with or without a query) is resolved; any other return path is kept as it is.
  if (new URL(next, "http://entry.invalid").pathname !== "/") return next;
  try {
    const first = (await (await guards()).listLanes())[0]?.laneId;
    return first ? `/${first}` : "/";
  } catch {
    return "/"; // the entry page shows the right error or notice
  }
}
