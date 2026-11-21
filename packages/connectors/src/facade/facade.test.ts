// The comms facade (T-255): dispatch by the connection ROW's provider, the enabled-provider gate before any provider call (and so any
// token read), the T-247 owner check, Microsoft answering unsupported_op, and one tick over a lane holding Google and Microsoft
// connections. The lane config is the real reader over a fake database client, so the configs below are validated by the real schema.
// Synthetic data only (rule 10); the entries are spies, nothing calls a network.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createConnSyncJob } from "../sync/job";
import type { SyncRunStore } from "../sync/types";
import { createLaneConfigReader } from "../vault/lane-config";
import { createCommsFacade, type CommsEntry, type FacadeConn } from "./facade";
import { microsoftEntry } from "./entries";
import { createProviderGate, isProviderDisabledError, PROVIDER_DISABLED_MESSAGE } from "./gate";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OWNER = "00000000-0000-4000-8000-00000000c001";
const OTHER = "00000000-0000-4000-8000-00000000c002";
const ids = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

type Config = Record<string, unknown> | null;
/** The real lane-config reader over a fake client; `state.config` can change between calls. */
function lane(initial: Config) {
  const state = { config: initial, reads: 0 };
  const client = { schema: () => ({ from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => { state.reads += 1; return { data: state.config === null ? null : { config: state.config }, error: null }; } }; return q; } }) };
  const reader = createLaneConfigReader((async () => client) as never);
  return { state, reader };
}
const GOOGLE_ONLY = { mail: { providers: ["google"] } };
const MS_ONLY = { mail: { providers: ["microsoft"] }, microsoft: { tenant_ids: [TENANT] } };
const BOTH = { mail: { providers: ["google", "microsoft"] }, microsoft: { tenant_ids: [TENANT] } };

function rows(list: { id: string; provider: "google" | "microsoft" | "quickbooks"; owner?: string | null; lane?: string; status?: string }[]) {
  const map = new Map<string, LaneBoundConnection<string>>();
  for (const r of list) {
    map.set(r.id, mintLaneBoundConnection({ id: r.id, lane_id: r.lane ?? "PKG", provider: r.provider, external_account_id: `${r.id.slice(-2)}@example.test`, status: (r.status ?? "active") as Connection["status"], features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: r.owner === undefined ? OWNER : r.owner } as Connection<string>));
  }
  return { async loadConnection(laneId: string, id: string) { const c = map.get(id); if (!c || c.lane_id !== laneId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" }); return c; } };
}

/** A spy entry: every call is recorded as "<provider>:<op>:<connection id>"; any of them could read a token, so the log is the "token read" log. */
function spyEntry(provider: "google" | "microsoft", log: string[]): CommsEntry {
  const run = (op: string) => async (_l: string, c: FacadeConn) => { log.push(`${provider}:${op}:${c.id}`); return { mode: "full" as const, pages: 1, written: 1, skipped: 0, removed: 0, resynced: false, conflict: false }; };
  return {
    provider,
    async readBody(_l, c) { log.push(`${provider}:readBody:${c.id}`); return { text: `${provider} body`, truncated: false }; },
    async search(_l, c) { log.push(`${provider}:search:${c.id}`); throw new Error("not used"); },
    async prepareWrite(_l, c) { log.push(`${provider}:prepareWrite:${c.id}`); return { action_type: "email.send", target: {}, payload: {}, payload_schema_version: 1, provider } as never; },
    mailSync: { run: run("mail") },
    calendarSync: { run: run("calendar") },
  };
}

function setup(cfg: Config, list: Parameters<typeof rows>[0], withMicrosoftSpy = true) {
  const log: string[] = [];
  const l = lane(cfg);
  const loader = rows(list);
  const gate = createProviderGate({ laneConfig: l.reader });
  const facade = createCommsFacade({ loader, gate, entries: { google: spyEntry("google", log), microsoft: withMicrosoftSpy ? spyEntry("microsoft", log) : microsoftEntry } });
  return { log, l, loader, gate, facade };
}

const G1 = ids(11);
const M1 = ids(12);
const G2 = ids(13);

describe("dispatch by the connection row's provider", () => {
  it("sends each read to the entry of its own row's provider (one lane, both providers, same user)", async () => {
    const { log, facade } = setup(BOTH, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }]);
    expect((await facade.readBody("PKG", G1, "m1")).text).toBe("google body");
    expect((await facade.readBody("PKG", M1, "m1")).text).toBe("microsoft body");
    await facade.prepareEmailWrite("PKG", G1, { action_type: "email.send", compose: {} } as never);
    await facade.prepareEmailWrite("PKG", M1, { action_type: "email.send", compose: {} } as never);
    expect(log).toEqual([`google:readBody:${G1}`, `microsoft:readBody:${M1}`, `google:prepareWrite:${G1}`, `microsoft:prepareWrite:${M1}`]);
  });

  it("a lane with [google, microsoft] AND mail_transport composio is a valid config: a Microsoft connection still goes to the Microsoft entry, never to Composio or Google", async () => {
    const cfg = { ...BOTH, mail_transport: "composio" };
    const { log, l, facade } = setup(cfg, [{ id: M1, provider: "microsoft" }, { id: G1, provider: "google" }]);
    await expect(l.reader.mailProviderSettings("PKG")).resolves.toMatchObject({ providers: ["google", "microsoft"] }); // the config parses
    await facade.readBody("PKG", M1, "m1");
    await facade.syncMail("PKG", M1);
    expect(log).toEqual([`microsoft:readBody:${M1}`, `microsoft:mail:${M1}`]);
    expect(log.some((e) => e.startsWith("google:"))).toBe(false);
  });

  it("the real Microsoft entry answers unsupported_op for every call, with no token read", async () => {
    const { facade } = setup(BOTH, [{ id: M1, provider: "microsoft" }], false);
    for (const call of [() => facade.readBody("PKG", M1, "m"), () => facade.search("PKG", M1, { query: "x" }), () => facade.prepareEmailWrite("PKG", M1, { action_type: "email.send", compose: {} } as never), () => facade.syncMail("PKG", M1), () => facade.syncCalendar("PKG", M1)]) {
      await expect(call()).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    }
  });

  it("refuses a row that is not a mail or calendar connection, and another lane's id (not_found)", async () => {
    const { facade } = setup(BOTH, [{ id: ids(20), provider: "quickbooks", owner: null }, { id: G1, provider: "google", lane: "OTH" }]);
    await expect(facade.readBody("PKG", ids(20), "m")).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    await expect(facade.readBody("PKG", G1, "m")).rejects.toMatchObject({ info: { kind: "not_found" } });
  });

  it("T-247: a mailbox is read only on behalf of its owner, for either provider, before any provider call", async () => {
    const { log, facade } = setup(BOTH, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }]);
    for (const id of [G1, M1]) await expect(facade.readBody("PKG", id, "m", OTHER)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(log).toEqual([]);
    await expect(facade.readBody("PKG", G1, "m", OWNER)).resolves.toMatchObject({ text: "google body" });
  });
});

describe("provider gate: a provider not enabled for the lane is refused before any provider call", () => {
  it("a lane with [google] holding a Microsoft row: the read is refused, nothing is called; the Google row works", async () => {
    const { log, facade } = setup(GOOGLE_ONLY, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }]);
    const err = await facade.readBody("PKG", M1, "m").catch((e: unknown) => e);
    expect(isProviderDisabledError(err)).toBe(true);
    expect((err as ConnectorError).info.message).toBe(PROVIDER_DISABLED_MESSAGE);
    expect(log).toEqual([]);
    await expect(facade.readBody("PKG", G1, "m")).resolves.toBeDefined();
  });

  it("a lane with [microsoft] holding a Google row: the reverse", async () => {
    const { log, facade } = setup(MS_ONLY, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }]);
    expect(isProviderDisabledError(await facade.readBody("PKG", G1, "m").catch((e: unknown) => e))).toBe(true);
    expect(isProviderDisabledError(await facade.prepareEmailWrite("PKG", G1, { action_type: "email.send", compose: {} } as never).catch((e: unknown) => e))).toBe(true);
    expect(log).toEqual([]);
    await expect(facade.readBody("PKG", M1, "m")).resolves.toBeDefined();
  });

  it("a Microsoft row in a lane with no microsoft block is refused the same way (T-250 review L1); a lane with no config row allows Google only", async () => {
    // The reader itself refuses [microsoft] without the block (fail closed), so the "no block" shape that parses is [google] or no config.
    for (const cfg of [GOOGLE_ONLY, null, {}]) {
      const { log, facade } = setup(cfg, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }]);
      expect(isProviderDisabledError(await facade.readBody("PKG", M1, "m").catch((e: unknown) => e))).toBe(true);
      await expect(facade.readBody("PKG", G1, "m")).resolves.toBeDefined();
      expect(log).toEqual([`google:readBody:${G1}`]);
    }
  });

  it("the allow decision is ONE read of the lane config (mailProviderSettings), not two", async () => {
    const { l, gate } = setup(BOTH, []);
    await gate.enabled("PKG", "microsoft");
    expect(l.state.reads).toBe(1);
    await gate.enabled("PKG", "google");
    expect(l.state.reads).toBe(2);
  });

  it("a malformed or unreadable provider config fails closed (provider_error) and calls nothing; a non-mail provider needs no read", async () => {
    const { log, l, facade, gate } = setup({ mail: { providers: "google" } }, [{ id: G1, provider: "google" }]);
    await expect(facade.readBody("PKG", G1, "m")).rejects.toMatchObject({ info: { kind: "provider_error" } });
    expect(log).toEqual([]);
    const reads = l.state.reads;
    await expect(gate.enabled("PKG", "quickbooks")).resolves.toBe(true);
    expect(l.state.reads).toBe(reads);
  });

  it("a config change is seen at the next call (no cache)", async () => {
    const { l, facade } = setup(BOTH, [{ id: M1, provider: "microsoft" }]);
    await expect(facade.readBody("PKG", M1, "m")).resolves.toBeDefined();
    l.state.config = GOOGLE_ONLY;
    expect(isProviderDisabledError(await facade.readBody("PKG", M1, "m").catch((e: unknown) => e))).toBe(true);
  });
});

/** conn.sync over the facade's runners and gate; the run log is a spy. */
function tick(cfg: Config, list: Parameters<typeof rows>[0], withMicrosoftSpy = true) {
  const s = setup(cfg, list, withMicrosoftSpy);
  const runLog: string[] = [];
  const runs: SyncRunStore = {
    async start(_l, c) { runLog.push(`start:${c.id}`); return { runId: `r-${c.id}` }; },
    async finish(_l, c, _r, result) { runLog.push(`finish:${c.id}:${result.status}`); },
    async recordOutcome(_l, c, o) { runLog.push(`outcome:${c.id}:${o.ok}`); },
  };
  const job = createConnSyncJob({ loader: s.loader, runs, runners: s.facade.syncRunners(), gate: (laneId, conn) => s.gate.enabled(laneId, conn.provider) });
  return { ...s, runLog, job };
}

describe("one lane's tick over Google and Microsoft connections (conn.sync with the facade's runners and gate)", () => {
  it("a Google and a Microsoft connection of the same user are both dispatched, each to its own runner", async () => {
    const t = tick(BOTH, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }]);
    const out = await Promise.all([G1, M1].map((id) => t.job.run("PKG", id, { trigger: "schedule" })));
    expect(out.map((o) => o.ok)).toEqual([true, true]);
    expect(out.map((o) => (o.ok && o.skipped === null ? o.provider : null))).toEqual(["google", "microsoft"]);
    expect([...t.log].sort()).toEqual([`google:calendar:${G1}`, `google:mail:${G1}`, `microsoft:calendar:${M1}`, `microsoft:mail:${M1}`]);
  });

  it("a lane with [google] holding a Microsoft row: that row is skipped provider_disabled before any run is logged or provider called; the Google rows sync", async () => {
    const t = tick(GOOGLE_ONLY, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }, { id: G2, provider: "google" }]);
    const out = await Promise.all([G1, M1, G2].map((id) => t.job.run("PKG", id, { trigger: "schedule" })));
    expect(out[1]).toEqual({ ok: true, skipped: "provider_disabled" });
    expect(out[0]).toMatchObject({ ok: true, skipped: null, provider: "google" });
    expect(out[2]).toMatchObject({ ok: true, skipped: null, provider: "google" });
    expect(t.log.filter((e) => e.startsWith("microsoft:"))).toEqual([]);
    expect(t.runLog.filter((e) => e.includes(M1))).toEqual([]); // no run row, no outcome: the connection's status and last_error are untouched
  });

  it("a lane with [microsoft] holding a Google row: the reverse", async () => {
    const t = tick(MS_ONLY, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }]);
    const out = await Promise.all([G1, M1].map((id) => t.job.run("PKG", id, { trigger: "schedule" })));
    expect(out[0]).toEqual({ ok: true, skipped: "provider_disabled" });
    expect(out[1]).toMatchObject({ ok: true, skipped: null, provider: "microsoft" });
    expect(t.log.filter((e) => e.startsWith("google:"))).toEqual([]);
    expect(t.runLog.filter((e) => e.includes(G1))).toEqual([]);
  });

  it("a Microsoft row in a lane with no microsoft block is skipped provider_disabled", async () => {
    const t = tick(null, [{ id: M1, provider: "microsoft" }]);
    expect(await t.job.run("PKG", M1, { trigger: "schedule" })).toEqual({ ok: true, skipped: "provider_disabled" });
    expect(t.log).toEqual([]);
  });

  it("Microsoft enabled, runner not built yet: the run fails unsupported_op (not retried) and nothing else is touched", async () => {
    const t = tick(BOTH, [{ id: G1, provider: "google" }, { id: M1, provider: "microsoft" }], false);
    const ms = await t.job.run("PKG", M1, { trigger: "schedule" });
    expect(ms).toMatchObject({ ok: false, retryable: false, errorKind: "unsupported_op" });
    await expect(t.job.run("PKG", G1, { trigger: "schedule" })).resolves.toMatchObject({ ok: true, skipped: null });
  });

  it("an unreadable lane config fails closed as a failed outcome with no run logged and no provider call", async () => {
    const t = tick({ mail: { providers: [] } }, [{ id: G1, provider: "google" }]);
    expect(await t.job.run("PKG", G1, { trigger: "schedule" })).toMatchObject({ ok: false, errorKind: "provider_error" });
    expect(t.log).toEqual([]);
    expect(t.runLog).toEqual([]);
  });

  it("the runners themselves also refuse a disabled provider (defence in depth when reached without the job's gate)", async () => {
    const t = tick(GOOGLE_ONLY, [{ id: M1, provider: "microsoft" }]);
    const conn = await t.loader.loadConnection("PKG", M1);
    await expect(t.facade.syncRunners().microsoft("PKG", conn)).rejects.toMatchObject({ info: { message: PROVIDER_DISABLED_MESSAGE } });
    expect(t.log).toEqual([]);
  });

  it("a Microsoft row never reaches the Google runner (provider mismatch is refused before any call)", async () => {
    const t = tick(BOTH, [{ id: M1, provider: "microsoft" }]);
    const conn = await t.loader.loadConnection("PKG", M1);
    await expect(t.facade.syncRunners().google("PKG", conn)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(t.log).toEqual([]);
  });
});
