// The portal's own Teams read markers (T-282, T-283; spec 7.2, 8.1): `comms.teams_chat_reads` through the signed-in person's OWN lane client and the `core` wrappers (RLS: the owner of the
// Teams connection at AAL2 only; a marker of anyone else is simply not returned). A marker is a chat id and a time (Microsoft's clock): nothing about the chat's content. Never touches Microsoft.
import type { LaneClient } from "@nichols/core/lane-router";

type Db = Pick<LaneClient, "schema">;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
const rpc = (client: Db): Rpc => {
  const core = client.schema("core");
  return core.rpc.bind(core) as unknown as Rpc;
};

/** chat id -> `read_through` (ISO) for one of the caller's Teams connections. Throws on a database error: the list then says "could not load", never "everything is read". */
export async function readMarkers(client: Db, laneId: string, connectionId: string): Promise<Map<string, string>> {
  const { data, error } = await rpc(client)("teams_chat_reads_list", { p_lane: laneId, p_connection: connectionId });
  if (error || !Array.isArray(data)) throw new Error("markers unavailable");
  const out = new Map<string, string>();
  for (const r of data as unknown[]) {
    if (typeof r !== "object" || r === null) continue;
    const { chat_id, read_through } = r as { chat_id?: unknown; read_through?: unknown };
    if (typeof chat_id === "string" && typeof read_through === "string" && !Number.isNaN(Date.parse(read_through))) out.set(chat_id, new Date(Date.parse(read_through)).toISOString());
  }
  return out;
}

/** Records that the caller has seen a chat up to a message time. Returns false when the database refused (not the caller's connection, a time too far ahead, ...). */
export async function markRead(client: Db, laneId: string, connectionId: string, chatId: string, readThrough: string): Promise<boolean> {
  const { error } = await rpc(client)("teams_chat_read_mark", { p_lane: laneId, p_connection: connectionId, p_chat: chatId, p_read_through: readThrough });
  return !error;
}
