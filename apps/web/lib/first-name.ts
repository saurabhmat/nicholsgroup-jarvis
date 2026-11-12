// The signed-in user's first name for the Home heading (T-237 part C). The one reliable server-side source is the user's own
// profile row, core.users.display_name (RLS: a user reads their own row at AAL2). Nothing is invented: no row, an unreadable
// row or a blank name gives undefined and Home says just "Good morning".
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";

/** "Robert Nichols" -> "Robert". A leading title ("Dr.", "Mr.") is skipped; a name that is only an email address is no name. */
export function firstNameOf(displayName: unknown): string | undefined {
  if (typeof displayName !== "string") return undefined;
  const words = displayName.trim().split(/\s+/).filter((w) => w !== "");
  const TITLES = new Set(["dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "prof", "prof."]);
  const first = words.find((w) => !TITLES.has(w.toLowerCase()));
  if (!first || first.includes("@") || first.length > 40) return undefined;
  return first;
}

type Db = Pick<LaneClient, "schema">;

export async function loadFirstName(client: Db, userId: string): Promise<string | undefined> {
  const { data, error } = await client.schema("core").from("users").select("display_name").eq("id", userId).maybeSingle();
  if (error) return undefined;
  return firstNameOf((data as { display_name?: unknown } | null)?.display_name);
}

/** Never throws: any failure leaves the heading without a name. */
export async function firstNameFor(g: Pick<Guards, "requireLane">, laneId: string, userId: string, load = loadFirstName): Promise<string | undefined> {
  try {
    const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
    return await load(client, userId);
  } catch {
    return undefined;
  }
}
