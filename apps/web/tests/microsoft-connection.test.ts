// T-257: Settings -> Connections, Google and Microsoft sections side by side. Which section shows comes from the one providers answer; a provider
// that is not enabled lists its rows as paused. Role gating and the shape of the output. Mocks only (no database, no Microsoft).
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { googleSectionFor } from "../lib/google-connection";
import { microsoftSectionFor } from "../lib/microsoft-connection";
import type { MailProvidersView } from "../lib/mail-providers";

const ME = "00000000-0000-4000-8000-0000000000a1";
const SOMEONE = "00000000-0000-4000-8000-0000000000a2";
const G_ID = "00000000-0000-4000-8000-0000000000c1";
const M_ID = "00000000-0000-4000-8000-0000000000c2";
const M_OTHER = "00000000-0000-4000-8000-0000000000c3";
const TENANT = "11111111-1111-4111-8111-111111111111";

const rows = {
  google: [{ id: G_ID, external_account_id: "me@corp.example.test", status: "active", owner_user_id: ME }],
  microsoft: [
    { id: M_ID, external_account_id: "me@corp.example.test", status: "active", owner_user_id: ME, access_token: "synthetic-token-leak" },
    { id: M_OTHER, external_account_id: "other@corp.example.test", status: "reconnect_required", owner_user_id: SOMEONE },
  ],
} as Record<string, unknown[]>;

/** A lane client that answers `connections` by the `provider` filter it was given (the two sections read the same table). */
function client(seen: string[][] = []) {
  return {
    schema: () => ({
      from: (table: string) => {
        const filters: string[] = [];
        seen.push(filters);
        const result = () => {
          const provider = filters.find((f) => f.startsWith("provider="))?.slice(9) ?? "";
          if (table === "connections") return { data: rows[provider] ?? [], error: null };
          if (table === "lane_config_current") return { data: { mailboxes: [], mail: { allowed_domains: ["corp.example.test"] } }, error: null };
          return { data: [], error: null };
        };
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (c: string, v: unknown) => (filters.push(`${c}=${String(v)}`), chain),
          in: () => chain,
          order: () => Promise.resolve(result()),
          maybeSingle: () => Promise.resolve(result()),
          then: (f: (v: unknown) => unknown) => Promise.resolve(result()).then(f),
        };
        return chain;
      },
    }),
  };
}
const guards = (over: { role?: AuthError } = {}) => ({
  requireRole: vi.fn(async (_l: string, roles: readonly string[]) => {
    if (over.role) throw over.role;
    void roles;
    return { session: { userId: ME }, client: client() } as never;
  }),
});

const both: MailProvidersView = { state: "known", google: true, microsoft: { cloud: "commercial", tenantIds: [TENANT] } };
const googleOnly: MailProvidersView = { state: "known", google: true, microsoft: null };
const microsoftOff = googleOnly; // "disabled after connect" is the same answer: Microsoft not enabled
const consent = vi.fn<(laneId: string, settings: unknown) => Promise<{ url: string | null; writes: boolean }>>(async () => ({ url: "https://login.microsoftonline.com/x/v2.0/adminconsent?synthetic" as string | null, writes: false }));

describe("a company with both providers enabled", () => {
  it("shows both sections, and the same user's Google row and Microsoft row each in its own section", async () => {
    const g = guards();
    const google = await googleSectionFor(g, "PKG", undefined, both);
    const microsoft = await microsoftSectionFor(g, "PKG", both, undefined, consent);
    expect(google?.paused).toBeUndefined();
    expect(microsoft?.paused).toBeUndefined();
    expect(google?.connections.map((c) => c.id)).toEqual([G_ID]);
    expect(microsoft?.connections.map((c) => c.id)).toEqual([M_ID, M_OTHER]);
    expect(microsoft?.connections.map((c) => c.mine)).toEqual([true, false]);
    expect(microsoft?.adminConsentUrl).toBe("https://login.microsoftonline.com/x/v2.0/adminconsent?synthetic");
    expect(microsoft?.writes).toBe(false);
    // the same address, one row per provider
    expect(google?.connections[0]?.mailbox).toBe(microsoft?.connections[0]?.mailbox);
  });
  it("the Microsoft read filters on provider microsoft (and never the Google transport filter); the Google read is unchanged", async () => {
    const seen: string[][] = [];
    await microsoftSectionFor({ requireRole: async () => ({ session: { userId: ME }, client: client(seen) }) as never }, "PKG", both, undefined, consent);
    expect(seen[0]).toEqual(["lane_id=PKG", "provider=microsoft"]);
    const seenG: string[][] = [];
    await googleSectionFor({ requireRole: async () => ({ session: { userId: ME }, client: client(seenG) }) as never }, "PKG", undefined, both);
    expect(seenG[0]).toEqual(["lane_id=PKG", "provider=google", "transport=native"]);
  });
  it("the output holds only the address, state, flags and sync times (no token, tenant or cursor)", async () => {
    const view = await microsoftSectionFor(guards(), "PKG", both, undefined, consent);
    expect(JSON.stringify(view)).not.toMatch(/token-leak|access_token|tenant/i);
    expect(consent).toHaveBeenCalledWith("PKG", { cloud: "commercial", tenantIds: [TENANT] });
  });
});

describe("a company with only Google", () => {
  it("has no Microsoft section (no rows), and Google is drawn as before", async () => {
    const g = { requireRole: async () => ({ session: { userId: ME }, client: client() }) as never };
    const saved = rows.microsoft as unknown[];
    rows.microsoft = [];
    try {
      expect(await microsoftSectionFor(g, "PKG", googleOnly, undefined, consent)).toBeNull();
      expect((await googleSectionFor(g, "PKG", undefined, googleOnly))?.paused).toBeUndefined();
    } finally {
      rows.microsoft = saved;
    }
  });
  it("builds no consent link and reads no client for a Microsoft that is not enabled", async () => {
    const link = vi.fn();
    await microsoftSectionFor(guards(), "PKG", googleOnly, undefined, link);
    expect(link).not.toHaveBeenCalled();
  });
});

describe("Microsoft disabled after a connect", () => {
  it("the Microsoft rows are kept and marked paused, with no consent link", async () => {
    const view = await microsoftSectionFor(guards(), "PKG", microsoftOff, undefined, consent);
    expect(view?.paused).toBe(true);
    expect(view?.adminConsentUrl).toBeNull();
    expect(view?.writes).toBeNull(); // nothing is claimed about scopes for a paused connection
    expect(view?.connections.map((c) => c.id)).toEqual([M_ID, M_OTHER]);
  });
  it("Google switched off is paused the same way, only when the list is known", async () => {
    const off: MailProvidersView = { state: "known", google: false, microsoft: null };
    expect((await googleSectionFor(guards(), "PKG", undefined, off))?.paused).toBe(true);
    expect((await googleSectionFor(guards(), "PKG", undefined, { state: "unknown" }))?.paused).toBeUndefined();
    expect((await googleSectionFor(guards(), "PKG", undefined, undefined))?.paused).toBeUndefined();
    const saved = rows.google as unknown[];
    rows.google = [];
    try {
      expect(await googleSectionFor({ requireRole: async () => ({ session: { userId: ME }, client: client() }) as never }, "PKG", undefined, off)).toBeNull();
    } finally {
      rows.google = saved;
    }
  });
});

describe("when the list of providers could not be read", () => {
  const unknown: MailProvidersView = { state: "unknown" };
  const noRows = { requireRole: async () => ({ session: { userId: ME }, client: client() }) as never };
  it("Google is never hidden or paused", async () => {
    expect((await googleSectionFor(guards(), "PKG", undefined, unknown))?.connections).toHaveLength(1);
  });
  it("with no Microsoft rows nothing about Microsoft is drawn at all", async () => {
    const saved = rows.microsoft as unknown[];
    rows.microsoft = [];
    try {
      expect(await microsoftSectionFor(noRows, "PKG", unknown, undefined, consent)).toBeNull();
    } finally {
      rows.microsoft = saved;
    }
  });
  it("with Microsoft rows they are kept (own and others'), flagged settingsUnknown, and no consent link is built (fail closed)", async () => {
    consent.mockClear();
    const view = await microsoftSectionFor(guards(), "PKG", unknown, undefined, consent);
    expect(view).toMatchObject({ settingsUnknown: true, adminConsentUrl: null, writes: null });
    expect(view?.paused).toBeUndefined();
    expect(view?.unavailable).toBeUndefined();
    expect(view?.connections.map((c) => c.id)).toEqual([M_ID, M_OTHER]);
    expect(consent).not.toHaveBeenCalled();
  });
  it("a failed connections read is `unavailable` only where Microsoft is enabled; otherwise nothing", async () => {
    const boom = async () => { throw new Error("db"); };
    expect((await microsoftSectionFor(guards(), "PKG", both, boom, consent))?.unavailable).toBe(true);
    expect(await microsoftSectionFor(guards(), "PKG", unknown, boom, consent)).toBeNull();
    expect(await microsoftSectionFor(guards(), "PKG", googleOnly, boom, consent)).toBeNull();
  });
});

describe("the wording switch", () => {
  it("is taken from the connect info of the same call (writes on)", async () => {
    const on = vi.fn(async () => ({ url: "https://login.microsoftonline.com/x/v2.0/adminconsent?s", writes: true }));
    expect((await microsoftSectionFor(guards(), "PKG", both, undefined, on))?.writes).toBe(true);
  });
  it("an unreadable policy is writes true, never a guess of read-only", async () => {
    const view = await microsoftSectionFor(guards(), "PKG", both, undefined, async () => { throw new Error("x"); });
    expect(view?.writes).toBe(true);
  });
});

describe("who sees the section", () => {
  it("a caller without own_mail (or not in the lane, or at AAL1) gets nothing; so does a null providers answer", async () => {
    for (const reason of ["forbidden", "mfa_required"] as const) expect(await microsoftSectionFor(guards({ role: new AuthError(reason) }), "PKG", both, undefined, consent)).toBeNull();
    expect(await microsoftSectionFor(guards(), "PKG", null, undefined, consent)).toBeNull();
  });
  it("asks for exactly the own_mail roles", async () => {
    const g = guards();
    await microsoftSectionFor(g, "PKG", both, undefined, consent);
    expect([...(g.requireRole.mock.calls[0]?.[1] ?? [])].sort()).toEqual(["admin_technical", "owner", "viewer"]);
  });
});
