// Composio mocks (MSW, T-219). Fake of the Composio REST API as `@composio/core` 0.27.0 calls it (paths under
// /api/v3.1). Synthetic data only; nothing here talks to the real service (CLAUDE.md rule 10). The request log keeps
// method + path + (for execute) the slug, never headers, so a test can prove which calls were made, and that none was.
import { http, HttpResponse, type RequestHandler } from "msw";

export const API = "https://backend.composio.dev";

export type FakeAccount = { id: string; status: string; toolkit: string; isDisabled?: boolean; userId?: string; authConfigId?: string };
export type FakeToolResult = { successful: boolean; data: Record<string, unknown>; error?: string | null };

export type FakeComposio = {
  /** Connected accounts by id. */
  accounts: Map<string, FakeAccount>;
  /** Tool results by slug; a slug missing here answers 404 at the tool lookup. */
  tools: Map<string, FakeToolResult>;
  /** Requests received: `METHOD /path` (execute: `EXECUTE SLUG`). Never headers or bodies. */
  requests: string[];
  /** Headers seen on the last request (names + `x-api-key` value) so a test can assert the key was sent, once. */
  lastApiKey: string | null;
  /** The body of the last link call (callback url, user id, auth config id). */
  lastLinkBody: Record<string, unknown> | null;
  /** The last execute body (arguments + connected account + user id). */
  lastExecuteBody: Record<string, unknown> | null;
  /** The redirect URL link answers with. */
  redirectUrl: string;
  /** Id of the next account created by link. */
  nextAccountId: string;
  handlers: RequestHandler[];
};

const iso = "2026-11-08T12:00:00.000Z";

export function createFakeComposio(): FakeComposio {
  const f: FakeComposio = {
    accounts: new Map(),
    tools: new Map(),
    requests: [],
    lastApiKey: null,
    lastLinkBody: null,
    lastExecuteBody: null,
    redirectUrl: "https://connect.composio.dev/link/lk_synthetic1",
    nextAccountId: "ca_synthetic1",
    handlers: [],
  };
  const log = (request: Request, label?: string) => {
    f.lastApiKey = request.headers.get("x-api-key");
    f.requests.push(label ?? `${request.method} ${new URL(request.url).pathname}`);
  };
  const accountJson = (a: FakeAccount) => ({
    id: a.id,
    auth_config: { id: a.authConfigId ?? "ac_synthetic", auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false },
    status: a.status,
    status_reason: null,
    toolkit: { slug: a.toolkit },
    is_disabled: a.isDisabled === true,
    created_at: iso,
    updated_at: iso,
    deprecated: { uuid: "00000000-0000-4000-8000-000000000000", authConfigUuid: "00000000-0000-4000-8000-000000000001" },
  });
  f.handlers = [
    http.get(`${API}/api/v3.1/connected_accounts`, ({ request }) => {
      log(request);
      // Filters as the SDK sends them (`user_ids`, `auth_config_ids`; repeated or bracketed keys); statuses: ACTIVE only unless asked.
      const q = new URL(request.url).searchParams;
      const want = (name: string) => [...q.entries()].filter(([k]) => k.replace(/\[\]$/, "") === name).flatMap(([, v]) => v.split(","));
      const users = want("user_ids");
      const configs = want("auth_config_ids");
      const items = [...f.accounts.values()].filter((a) => (users.length === 0 || (a.userId !== undefined && users.includes(a.userId))) && (configs.length === 0 || configs.includes(a.authConfigId ?? "ac_synthetic")));
      return HttpResponse.json({ items: items.map(accountJson), next_cursor: null, total_pages: 1, current_page: 1, total_items: f.accounts.size });
    }),
    http.post(`${API}/api/v3.1/connected_accounts/link`, async ({ request }) => {
      log(request);
      f.lastLinkBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ link_token: "lt_synthetic", redirect_url: f.redirectUrl, expires_at: "2026-11-08T13:00:00.000Z", connected_account_id: f.nextAccountId });
    }),
    http.get(`${API}/api/v3.1/connected_accounts/:id`, ({ request, params }) => {
      log(request);
      const a = f.accounts.get(String(params.id));
      return a ? HttpResponse.json(accountJson(a)) : HttpResponse.json({ error: { message: "not found" } }, { status: 404 });
    }),
    http.get(`${API}/api/v3.1/tools/:slug`, ({ request, params }) => {
      log(request);
      const slug = String(params.slug);
      if (!f.tools.has(slug)) return HttpResponse.json({ error: { message: "not found" } }, { status: 404 });
      return HttpResponse.json({
        slug,
        name: slug,
        description: "synthetic",
        input_parameters: { type: "object", properties: {} },
        output_parameters: { type: "object", properties: {} },
        available_versions: ["20261103_00"],
        version: "20261103_00",
        toolkit: { slug: slug.startsWith("GMAIL") ? "gmail" : "googlecalendar", name: "synthetic", logo: "" },
        tags: [],
        no_auth: false,
        is_deprecated: false,
        scopes: [],
      });
    }),
    http.post(`${API}/api/v3.1/tools/execute/:slug`, async ({ request, params }) => {
      const slug = String(params.slug);
      log(request, `EXECUTE ${slug}`);
      f.lastExecuteBody = (await request.json()) as Record<string, unknown>;
      const r = f.tools.get(slug);
      if (!r) return HttpResponse.json({ error: { message: "not found" } }, { status: 404 });
      return HttpResponse.json({ data: r.data, error: r.error ?? null, successful: r.successful, log_id: "log_synthetic" });
    }),
  ];
  return f;
}
