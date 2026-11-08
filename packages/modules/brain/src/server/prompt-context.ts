// Brain context for prompt assembly (T-212, spec §4). Loads what the prompt may contain, through the session-bound lane
// client only (the store's `clientFor`), and returns plain data for `assemblePrompt` in @nichols/ai/prompts:
//   - the caller's OWN About-Me and Preferences, read from their home lane (D-28), only kinds about_me/preferences;
//   - for each lane in scope, the caller's own Context pages and project briefs/handoffs of THAT lane only
//     (core.brain_document_get falls back to another owner's copy, so every page is checked `isMine`; there is no
//     "explicitly shared page" mechanism yet, so nothing but the caller's own rows is read: plan-review sec M-1);
//   - for an employee run: the stored config re-loaded with loadEmployeeConfig (fail closed) and permissions per lane.
// A page that cannot be read (brain not enabled for the lane, no membership, outage) is skipped with a code in `notes`:
// the assistant still answers, with fewer notes. Page text is never logged.
import type { LaneId } from "@nichols/core";
import { ABOUT_ME_PATH, PREFERENCES_PATH, effectivePermissionsByLane, kpisForLane, type ActionType, type EmployeeConfig, type LaneSettings } from "../domain/index";
import type { BrainEmployee, BrainStore } from "./store";

export type PromptStore = Pick<BrainStore, "listDocuments" | "getDocument" | "findHomeLane">;

export type BrainPromptContext = {
  brainUser: { ownerUserId: string; aboutMe: string | null; preferences: string | null } | null;
  laneBrain: Record<string, { path: string; kind: "context" | "project_brief" | "project_handoff"; updatedAt: string; body: string }[]>;
  /** Codes only, e.g. "home_lane_unavailable", "lane_unreadable:PKG". */
  notes: string[];
};

/** Most recent pages per lane that go to the prompt (the token cap then drops more). */
export const MAX_LANE_PAGES = 12;
const LANE_KINDS = new Set(["context", "project_brief", "project_handoff"]);

/**
 * `userId` must be the signed-in user (or the employee's owner for a run). Only that user's own rows are returned;
 * `lanes` are the lanes of the call and the only lanes read for pages.
 */
export async function loadBrainPromptContext(store: PromptStore, input: { userId: string; lanes: readonly LaneId[] }): Promise<BrainPromptContext> {
  const out: BrainPromptContext = { brainUser: null, laneBrain: {}, notes: [] };
  const lanes = [...new Set(input.lanes)];
  const first = lanes[0];
  if (first === undefined) return out;

  // D-28: About-Me and Preferences, from the home lane, in every lane's call. Own copies only.
  try {
    const home = await store.findHomeLane(first);
    if (home === null) out.notes.push("no_home_lane");
    else {
      const [about, prefs] = await Promise.all([store.getDocument(home, ABOUT_ME_PATH), store.getDocument(home, PREFERENCES_PATH)]);
      const mine = (d: typeof about, kind: string) => (d && d.isMine && d.kind === kind ? d.body : null);
      const aboutMe = mine(about, "about_me");
      const preferences = mine(prefs, "preferences");
      if (aboutMe !== null || preferences !== null) out.brainUser = { ownerUserId: input.userId, aboutMe, preferences };
    }
  } catch {
    out.notes.push("home_lane_unreadable");
  }

  for (const lane of lanes) {
    try {
      const metas = (await store.listDocuments(lane))
        .filter((m) => m.isMine && LANE_KINDS.has(m.kind))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_LANE_PAGES);
      const docs: BrainPromptContext["laneBrain"][string] = [];
      for (const m of metas) {
        const d = await store.getDocument(lane, m.path);
        if (d && d.isMine && LANE_KINDS.has(d.kind) && d.body.trim().length > 0) {
          docs.push({ path: d.path, kind: d.kind as "context" | "project_brief" | "project_handoff", updatedAt: d.updatedAt, body: d.body });
        }
      }
      if (docs.length) out.laneBrain[lane] = docs;
    } catch {
      out.notes.push(`lane_unreadable:${lane}`);
    }
  }
  return out;
}

export type EmployeePromptDeps = {
  /** store.loadEmployeeConfig: schema + lanes the user can open now + lane_config cross-checks; throws on any issue. */
  loadEmployeeConfig: (laneId: LaneId, stored: unknown) => Promise<EmployeeConfig>;
  policyFor: (lane: string) => { write_actions_allowed: readonly string[]; store_outbound_drafts: boolean };
  roleFor: (lane: string) => string;
  laneSettingsFor: (lane: string) => LaneSettings | null;
};

export type EmployeePromptBlock = {
  roleKey: string;
  name: string;
  instructions: string;
  summary: string[];
  userPreferences: string[];
  config: EmployeeConfig;
};

/**
 * The `employee` input of the prompt for one run. The stored config is re-validated every run and any failure throws
 * (EmployeeConfigError): the employee does not run on a tampered or stale config. Permissions are computed per lane
 * (each lane's own policy and the owner's role there) and are only DESCRIBED in the prompt; the approvals module and
 * the gate decide, never the prompt. The owner's include / topics text is returned separately as `userPreferences`.
 */
export async function buildEmployeePrompt(employee: Pick<BrainEmployee, "roleKey" | "name" | "instructions" | "config">, laneId: LaneId, deps: EmployeePromptDeps): Promise<EmployeePromptBlock> {
  const config = await deps.loadEmployeeConfig(laneId, employee.config);
  const perms = effectivePermissionsByLane(config.permissions.propose as ActionType[], config.lanes, deps.policyFor, deps.roleFor);
  const summary: string[] = [
    `Time zone: ${config.timezone}`,
    `Lanes: ${config.lanes.join(", ")}`,
    `Mailboxes: ${config.sources.mail.map((m) => `${m.lane} priority ${String(m.priority)}`).join("; ") || "none"}`,
    `Calendar: ${String(config.sources.calendar.days_ahead)} days ahead`,
    `Output: up to ${String(config.output.max_attention_items)} attention items, ${String(config.output.max_drafts)} drafts, about ${String(config.output.target_words)} words`,
    `Sections: ${config.output.sections.join(", ")}`,
    ...config.lanes.map((l) => {
      const s = deps.laneSettingsFor(l);
      const kpis = s ? kpisForLane(config, s) : [];
      return `Lane ${l}: may propose ${perms[l]?.allowed.join(", ") || "nothing"}${kpis.length ? `; KPIs ${kpis.join(", ")}` : ""}`;
    }),
  ];
  const userPreferences = [...config.sources.mail.flatMap((m) => m.include), ...config.sources.external.flatMap((e) => e.topics)];
  return { roleKey: employee.roleKey, name: employee.name, instructions: employee.instructions, summary, userPreferences, config };
}
