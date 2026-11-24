// A `microsoft_teams` row is never a mailbox (T-278, T-279; spec 4.1 reason 2, 7.1): every place that lists providers or dispatches on a connection's provider leaves Teams out, so a
// Teams-only account (Pub K style: Google mail, Microsoft Teams) can never fail a mail tick, appear in a briefing, be synced or reach a mail reader. Regression tests for the
// shared code this task touched, plus a source scan that makes every future mention of the provider explicit.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommsFacade } from "../facade/facade";
import { COMMS_PROVIDERS, createProviderGate, isCommsProvider } from "../facade/gate";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { PROVIDERS } from "../contract/schemas";
import { CONNECT_ROLES, MAIL_CONNECT_ROLES, connectRolesFor } from "../oauth/flow";
import { CALENDAR_PROVIDERS, MAIL_PROVIDERS as SYNC_MAIL_PROVIDERS } from "../sync/targets";
import { createSyncTargetLister } from "../sync/targets";
import { MAIL_PROVIDERS } from "../vault/connections";
import { createMicrosoftGuard } from "../microsoft/guard";
import { createMicrosoftDisconnect } from "../microsoft/disconnect";
import { CONTENT_PROVIDERS } from "../raw/guard";

const root = resolve(__dirname, "../../../..");
function production(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", "dist", ".turbo", ".git", "test-stubs"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(p);
    }
  };
  walk(join(root, "apps"));
  walk(join(root, "packages"));
  return files;
}
const rel = (f: string) => relative(root, f);

const TEAMS_ROW = { id: "00000000-0000-4000-8000-0000000c0279", lane_id: "PKG", provider: "microsoft_teams", external_account_id: "person@teams.example.test", status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: "00000000-0000-4000-8000-00000000a279" } as const;

/** A chainable fake of the supabase query builder that records every `.in(column, values)` and answers a fixed list of rows. */
function fakeClient(rows: unknown[]) {
  const ins: [string, unknown][] = [];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ["select", "eq", "neq", "order", "limit", "is", "not", "or"]) builder[m] = chain;
  builder.in = (c: string, v: unknown) => {
    ins.push([c, v]);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
  const client = { schema: () => ({ from: () => builder }) };
  return { client, ins };
}

describe("the provider lists that mean 'mailbox' do not contain Teams", () => {
  it("the contract knows the provider, and no mail or calendar list names it", () => {
    expect(PROVIDERS).toContain("microsoft_teams");
    for (const list of [MAIL_PROVIDERS, SYNC_MAIL_PROVIDERS, CALENDAR_PROVIDERS, COMMS_PROVIDERS, CONTENT_PROVIDERS] as readonly (readonly string[])[]) expect(list).not.toContain("microsoft_teams");
    expect(isCommsProvider("microsoft_teams")).toBe(false);
  });

  it("the sync target listers (mail and calendar ticks, Sync now) query google and microsoft only", async () => {
    const { client, ins } = fakeClient([]);
    const lister = createSyncTargetLister((async () => client) as never);
    await lister.listMailConnectionIds("PKG");
    await lister.listMailTargets("PKG");
    await lister.listCalendarConnectionIds("PKG");
    expect(ins.filter(([c]) => c === "provider")).toHaveLength(3);
    for (const [, v] of ins.filter(([c]) => c === "provider")) {
      expect(v).toEqual(["google", "microsoft"]);
      expect(v).not.toContain("microsoft_teams");
    }
  });

  it("the comms facade refuses a Teams connection before any config or token read; the provider gate says nothing about it", async () => {
    let configReads = 0;
    const gate = createProviderGate({ laneConfig: { mailProviderSettings: async () => (configReads++, { providers: ["google"], microsoft: null }) } });
    const conn = mintLaneBoundConnection(TEAMS_ROW as never);
    const facade = createCommsFacade({ loader: { loadConnection: async () => conn }, gate, entries: {} as never });
    await expect(facade.readBody("PKG", TEAMS_ROW.id, "m1")).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    await expect(facade.search("PKG", TEAMS_ROW.id, {} as never)).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    await expect(facade.syncMail("PKG", TEAMS_ROW.id)).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    await expect(facade.syncCalendar("PKG", TEAMS_ROW.id)).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    expect(configReads).toBe(0);
  });

  it("the Microsoft mail guard and the Microsoft mail Disconnect refuse a Teams row", async () => {
    const conn = mintLaneBoundConnection(TEAMS_ROW as never);
    const guard = createMicrosoftGuard({
      connections: { load: async () => conn },
      laneConfig: { mailProviderSettings: async () => ({ providers: ["microsoft"], microsoft: null }), mailboxes: async () => [], mailDomains: async () => [] },
      identity: { read: async () => ({ tenantId: null, cloud: null }) },
    });
    await expect(guard("PKG", conn)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    const revoked: string[] = [];
    const disconnect = createMicrosoftDisconnect({ loader: { loadConnection: async () => conn }, vault: { revokeToken: async (_l, c) => (revoked.push(c.id), true) } });
    await expect(disconnect("PKG", TEAMS_ROW.id, TEAMS_ROW.owner_user_id)).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(revoked).toEqual([]);
  });
});

describe("who may connect", () => {
  it("a person's own Teams account is connected by any member holding own_mail, like their own mailbox; QuickBooks stays owner and admin_technical", () => {
    expect(connectRolesFor("microsoft_teams")).toBe(MAIL_CONNECT_ROLES);
    expect(connectRolesFor("google")).toBe(MAIL_CONNECT_ROLES);
    expect(connectRolesFor("microsoft")).toBe(MAIL_CONNECT_ROLES);
    expect(connectRolesFor("quickbooks")).toBe(CONNECT_ROLES);
    expect(connectRolesFor("stripe")).toBe(CONNECT_ROLES);
    expect(connectRolesFor("microsoft_teams")).toContain("viewer");
  });
});

describe("source scan: every production file that names the provider is on this list", () => {
  it("microsoft_teams appears only where Teams is handled on purpose", () => {
    const named = production()
      .filter((f) => /microsoft_teams/.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => !f.startsWith("packages/eslint-plugin/src/") && !f.endsWith("/types.ts"))
      .sort();
    // Anything new here must be a deliberate Teams path: add it to this list in the task that adds it, with a test.
    expect(named).toEqual(
      [
        "apps/web/components/teams-disconnect-button.tsx",
        "apps/web/lib/home.ts",
        "apps/web/lib/teams-connection.ts",
        "apps/web/lib/teams-wording.ts",
        "packages/connectors/src/contract/schemas.ts",
        "packages/connectors/src/health/index.ts",
        // T-289: the subscription store records a Teams connection's notice subscription under this provider (and asks the receiver's lookup for it)
        "packages/connectors/src/microsoft/subscription-store.ts",
        "packages/connectors/src/oauth/flow.ts",
        // T-294: counts the person's own Teams connections (the start of a connect refuses at the company's limit), read under the person's own row-level security
        "packages/connectors/src/teams/accounts.ts",
        "packages/connectors/src/teams/constants.ts",
        "packages/connectors/src/teams/guard.ts",
        "packages/connectors/src/teams/http.ts",
        "packages/connectors/src/teams/identity.ts",
        // T-289: the in-memory twin of the subscription store labels a Teams subscription's provider (as the real store does); test support only
        "packages/connectors/src/testing/microsoft-subscription-store.ts",
        "packages/connectors/src/teams/provider.ts",
        "packages/connectors/src/testing/teams-harness.ts",
        "packages/connectors/src/vault/connections.ts",
        // T-286: the approvals-only write door (the loader that refuses a non-Teams row) and the approvals module's facts and executor wiring
        "packages/connectors/src/write/index.ts",
        "packages/modules/approvals/src/server/wire.ts",
      ].sort(),
    );
  });
});
