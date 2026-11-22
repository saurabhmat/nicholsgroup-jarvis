// Which modules a company shows (T-265). Driven only by lane_config (`enabled_modules` with `limit_to_enabled_modules`), never by a lane
// code (CLAUDE.md rule 2). A lane that does not limit itself shows everything, exactly as before; a limited lane (mail and calendar only,
// for example) drops finance tiles, the QuickBooks strip, Approvals, Projects, the assistant entry points and the setup entry from the
// navigation, Home and Settings. This decides what is DRAWN. It is not a permission: every read is still gated by RLS and the lane gate.
// The config row is readable only to owner and admin_technical (the `config` view); anyone else reads nothing and sees the unlimited
// default, which changes nothing they could read (the database still answers them nothing for a module they may not use).
import { cache } from "react";
import { redirect } from "next/navigation";
import { moduleVisible, type LaneModule } from "@nichols/core/lane-config";
import { laneHref, type NavKey } from "@nichols/ui";
import { guards } from "./guards";

export type LaneGate = {
  /** True when the lane lists its modules and hides the rest. */
  limited: boolean;
  visible: (module: LaneModule) => boolean;
  /** The GovCon news card: always on for an unlimited lane; for a limited lane only when its own `news.enabled` is true. */
  newsShown: boolean;
};

export const UNLIMITED: LaneGate = { limited: false, visible: () => true, newsShown: true };

type Row = { modules?: unknown; limited?: unknown; news?: unknown } | null;
type Db = { schema(name: "core"): { from(table: "lane_config_current"): { select(cols: string): { eq(col: string, v: string): { maybeSingle(): PromiseLike<{ data: Row; error: unknown }> } } } } };

/** The gate from the stored row. Unreadable or malformed = unlimited (this only hides screens). */
export function gateFrom(row: Row): LaneGate {
  if (!row) return UNLIMITED;
  const config = { enabled_modules: row.modules, limit_to_enabled_modules: row.limited };
  if (row.limited !== true) return UNLIMITED;
  const news = row.news;
  const newsEnabled = typeof news === "object" && news !== null && !Array.isArray(news) && (news as { enabled?: unknown }).enabled === true;
  return { limited: true, visible: (m) => moduleVisible(config, m), newsShown: newsEnabled };
}

/** One lane_config read. Only three keys are selected: nothing else of the config reaches this code. */
export async function loadLaneGate(client: unknown, laneId: string): Promise<LaneGate> {
  try {
    const { data, error } = await (client as Db).schema("core").from("lane_config_current").select("modules:config->enabled_modules, limited:config->limit_to_enabled_modules, news:config->news").eq("lane_id", laneId).maybeSingle();
    return error ? UNLIMITED : gateFrom(data);
  } catch {
    return UNLIMITED;
  }
}

/** Once per request and lane (React cache; the guards memoise the lane client the same way). */
export const laneGate = cache(async (laneId: string): Promise<LaneGate> => {
  try {
    const { client } = await (await guards()).requireLane(laneId as Parameters<Awaited<ReturnType<typeof guards>>["requireLane"]>[0]);
    return await loadLaneGate(client, laneId);
  } catch {
    return UNLIMITED;
  }
});

/** The navigation entry each module owns. Home and Settings belong to no module and are always shown. */
const NAV_OF: Partial<Record<LaneModule, NavKey>> = { finance: "finance", approvals: "approvals", assistant: "assistant", projects: "projects", comms: "inbox", calendar: "calendar", brain: "onboarding" };

/** The navigation keys a lane hides. Empty for an unlimited lane. */
export function hiddenNavKeys(gate: LaneGate): NavKey[] {
  return (Object.entries(NAV_OF) as [LaneModule, NavKey][]).filter(([m]) => !gate.visible(m)).map(([, k]) => k);
}

/**
 * For a page of a module: a lane that hides the module sends the visitor to the lane's Home. The company switcher keeps the page name
 * when it changes company (/AA/finance -> /BB/finance), so this is the landing for a page the other company does not have.
 */
export async function requireModule(laneId: string, module: LaneModule): Promise<void> {
  // Belt and braces: the gate only answers "hidden" for a company the caller really belongs to (the lane check ran), and the code is a plain code.
  if (/^[A-Z]{1,8}$/.test(laneId) && !(await laneGate(laneId)).visible(module)) redirect(laneHref(laneId));
}

/**
 * For an API route of a module (T-265): a limited company that does not list the module answers 404 `not_found` (the routes' own JSON error
 * style), so a hidden module has no endpoint either. Returns null to carry on with the route's own checks, which always run next: for an
 * unlimited company (and for anyone who is not a member, whose lane check fails inside `laneGate`) this returns null and the route behaves
 * exactly as before. This is tidiness, not a permission: RLS, the lane policy and each route's role checks remain the real gates.
 */
export async function hiddenModuleResponse(laneId: string | null, module: LaneModule): Promise<Response | null> {
  if (laneId === null || !/^[A-Z]{1,8}$/.test(laneId)) return null;
  if ((await laneGate(laneId)).visible(module)) return null;
  return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
}

/**
 * Whether the company's lane policy allows any email write action (`email_send` or `email_draft`). Used only for a LIMITED company, to
 * hide Reply where nothing could ever be saved or sent (the server already refuses with `drafts_not_allowed` / "not enabled"). A read
 * that fails answers true, so nothing is hidden on a guess. The caller must hold the `lane_policies` view (owner, admin_technical).
 */
export async function emailWriteAllowed(client: unknown, laneId: string): Promise<boolean> {
  type PolicyDb = { schema(n: "core"): { from(t: "lane_policies"): { select(c: string): { eq(k: string, v: string): { maybeSingle(): PromiseLike<{ data: { write_actions_allowed?: unknown } | null; error: unknown }> } } } } };
  try {
    const { data, error } = await (client as PolicyDb).schema("core").from("lane_policies").select("write_actions_allowed").eq("lane_id", laneId).maybeSingle();
    if (error || !data) return true;
    const list = data.write_actions_allowed;
    return Array.isArray(list) && (list.includes("email_send") || list.includes("email_draft"));
  } catch {
    return true;
  }
}
