// T-276: reads that several parts of one page render ask for, shared per request (React cache(), the same scope as the guards). Home used to read
// the lane's config row five times and the mail/calendar Coverage twice in one render. The key is the lane client object (the guards memoise one per
// lane and request) and the lane code, so two different callers or lanes never share an answer. Outside a render (route handlers, jobs, server
// actions, tests) cache() does not memoise and every call reads, exactly as before.
// Each caller still takes ONLY the keys it reads today out of the row (the gate: three keys; Coverage: the briefing thresholds; ...): nothing here widens
// what a module exposes. A rejection is memoised too, so every caller in the render gets the same answer.
import { cache } from "react";
import type { LaneClient } from "@nichols/core/lane-router";

type Db = Pick<LaneClient, "schema">;

/**
 * SECURITY: the whole `config` row is read into server memory for every page that asks (the gate runs on every gated page). `lane_config_current` must therefore never
 * hold a secret (CLAUDE.md rule 4: tokens, keys and client secrets live only in the Vault, never in lane_config). Callers copy out ONLY their own keys and keep nothing else.
 * `core.lane_config_current` for the lane (all callers select the whole `config`; readable only to the roles the view allows, anyone else gets an error or no row). */
export const laneConfigRow = cache((client: Db, laneId: string) => Promise.resolve(client.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle()));

/** `core.briefing_coverage` for the CALLER's own accounts (no `p_owner`: job callers that name an owner read directly). */
export const coverageRows = cache((client: Db, laneId: string) => Promise.resolve(client.schema("core").rpc("briefing_coverage", { p_lane: laneId })));
