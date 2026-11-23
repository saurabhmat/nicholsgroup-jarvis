// T-265: API routes of a module a limited company does not list answer 404 not_found; an unlimited company reaches the route's own
// handler exactly as before. The gate is tidiness: the handlers' own lane, role and RLS checks are untouched and still run next.
import { beforeEach, describe, expect, it, vi } from "vitest";

let row: unknown = null;
// T-276: the gate reads the shared whole-config row; this fake wraps the {modules, limited, news} rows as the stored config.
const stored = () => {
  const r = row as { modules?: unknown; limited?: unknown; news?: unknown } | null;
  return r ? { config: { enabled_modules: r.modules, limit_to_enabled_modules: r.limited, news: r.news } } : null;
};
const client = () => ({ schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stored(), error: null }) }) }) }) }) });
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane: async () => ({ client: client(), session: { userId: "u" } }) }), renewSessionFor: async () => undefined }));
const handled: string[] = [];
const handler = (name: string) => async () => (handled.push(name), new Response("handled", { status: 200 }));
vi.mock("@/lib/approvals", () => ({ handleApprovals: handler("approvals") }));
vi.mock("@/lib/assistant", () => ({ handleChat: handler("assistant") }));
vi.mock("@/lib/brain-import", () => ({ handleImport: handler("brain-import") }));
vi.mock("@/lib/brain-interview", () => ({ handleInterview: handler("brain-interview") }));
vi.mock("@/lib/reply", () => ({ createLimiter: () => ({}) }));
vi.mock("@nichols/ai/config", () => ({ getLLMProvider: () => ({ configured: false }) }));
vi.mock("@nichols/approvals/wire", () => ({ approvalsDeps: {}, approveAndExecuteEmail: async () => undefined }));
vi.mock("@nichols/connectors/facade", () => ({ readBody: async () => ({}) }));
vi.mock("@nichols/core/lane-router", () => ({ getAudit: () => ({}) }));
vi.mock("@/lib/connect", () => ({ connectAuthorizer: async () => async () => ({}) }));
vi.mock("@nichols/connectors/oauth", () => ({ oauthFlow: {}, createConnectHandlers: () => ({ start: handler("connect-start") }) }));
vi.mock("@nichols/connectors/connection-test", () => ({ checkQuickBooksConnection: async () => ({}) }));
vi.mock("@/lib/connection-test", () => ({ createConnectionCheckHandler: () => handler("qbo-check") }));

const LIMITED = { modules: ["comms", "calendar", "briefing"], limited: true, news: null };
const FULL = { modules: ["assistant"], limited: null, news: null };
const ctx = { params: Promise.resolve({ laneId: "XX" }) } as never;
const post = (url = "http://x.test/api") => new Request(url, { method: "POST" });

beforeEach(() => {
  handled.length = 0;
});

describe("module routes of a limited company (T-265)", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["approvals", async () => (await import("@/app/api/lanes/[laneId]/approvals/route")).POST(post(), ctx)],
    ["assistant", async () => (await import("@/app/api/lanes/[laneId]/assistant/route")).POST(post(), ctx)],
    ["brain-import", async () => (await import("@/app/api/lanes/[laneId]/brain/import/route")).POST(post(), ctx)],
    ["brain-interview", async () => (await import("@/app/api/lanes/[laneId]/brain/interview/route")).POST(post(), ctx)],
    ["qbo-check", async () => (await import("@/app/api/connection-test/qbo/check/route")).POST(post("http://x.test/api?lane=XX"))],
    ["connect-start", async () => (await import("@/app/api/connect/[provider]/start/route")).POST(post("http://x.test/api?lane=XX"), { params: Promise.resolve({ provider: "qbo" }) } as never)],
  ];
  for (const [name, call] of cases) {
    it(`${name}: 404 not_found for a company that does not list the module, the route's own handler otherwise`, async () => {
      row = LIMITED;
      const res = await call();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(handled).toEqual([]);
      row = FULL;
      expect((await call()).status).toBe(200);
      expect(handled).toHaveLength(1);
    });
  }

  it("a limited company that lists the module reaches the handler; Google connect is never gated; an unreadable config gates nothing", async () => {
    row = { ...LIMITED, modules: [...LIMITED.modules, "approvals", "assistant", "brain", "finance"] };
    for (const [, call] of cases) expect((await call()).status).toBe(200);
    handled.length = 0;
    row = LIMITED;
    const start = (await import("@/app/api/connect/[provider]/start/route")).POST;
    expect((await start(post("http://x.test/api?lane=XX"), { params: Promise.resolve({ provider: "google" }) } as never)).status).toBe(200);
    row = null;
    const [first] = cases;
    expect((await (first as (typeof cases)[number])[1]()).status).toBe(200);
  });
});
