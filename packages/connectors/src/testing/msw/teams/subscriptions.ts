// Fake Microsoft Graph SUBSCRIPTION endpoints for TEAMS (MSW) for the notice tests (T-289). Synthetic data only (rule 10). Faithful to the vendor facts sheet (.agent/notes/T-277-vendor-facts.md A3):
//  - `POST /subscriptions` validates the callback URL DURING the request (the test points `validator` at the real receiver): a failed validation answers 400 and creates nothing; both URLs must be https;
//  - the resource must be `users/<the account's object id>/chats/getAllMessages` (a leading slash is accepted); anything else answers 400. A test can make Microsoft REFUSE the all-chats resource
//    (`refuse`: the delegated form is "listed for v1.0 but shown only in a beta example": it may be refused) with any status and code;
//  - `changeType` must be a comma list of created, updated, deleted; `includeResourceData` is accepted by the fake only to RECORD that it was sent (a test expects it never is);
//  - the lifetime Microsoft GIVES is `grantMinutes` when a test sets it (4,320 by default for a longer request, 60 to model the other page of the documentation), whatever was asked;
//  - at most 10 live all-chats subscriptions per account (403 above that, as the quota says);
//  - `PATCH` takes `expirationDateTime` only and answers the subscription with the lifetime Microsoft gives; `DELETE` answers 204; an unknown, deleted or expired id answers 404 `ResourceNotFound`;
//  - the bearer token decides which account owns a subscription; another account's id answers 404.
// Every request is recorded (method, path, parsed body, the account's sign-in name). The clock is injectable (`setNow`).
import { randomUUID } from "node:crypto";
import { HttpResponse, http, type RequestHandler } from "msw";
import { GRAPH_V1, TEAMS_ERROR_TEXT_CANARY, type FakeTeams, type FakeTeamsAccount } from "./handlers";

const CHANGE_TYPES = new Set(["created", "updated", "deleted"]);
export const FAKE_TEAMS_MAX_ALL_CHATS_PER_USER = 10;

export type FakeTeamsSubscription = {
  id: string;
  account: FakeTeamsAccount;
  resource: string;
  changeType: string;
  notificationUrl: string;
  lifecycleNotificationUrl: string | null;
  expirationDateTime: number;
  clientState: string;
};
export type TeamsSubscriptionRequestRecord = { method: string; path: string; body: unknown; upn: string | null };
export type TeamsSubscriptionFailKey = "create" | "renew" | "delete";
export type TeamsValidationCall = (url: string, token: string) => Promise<Response>;

export interface FakeTeamsSubscriptions {
  handlers: RequestHandler[];
  subscriptions: Map<string, FakeTeamsSubscription>;
  requests: TeamsSubscriptionRequestRecord[];
  validations: { url: string; token: string; ok: boolean }[];
  validator: TeamsValidationCall | null;
  sawIncludeResourceData: number;
  /** Microsoft answers every create with this status and error code (the resource is not supported for a delegated token, the permission is missing...). */
  refuse: { status: number; code: string } | null;
  /** The lifetime Microsoft gives, in minutes, whatever was asked (null: the minimum of the request and 4,320). */
  grantMinutes: number | null;
  failNext(key: TeamsSubscriptionFailKey, status: number, times?: number): void;
  remove(id: string): void;
  setNow(ms: number): void;
  now(): number;
  /** A change-notification collection body as Graph sends it for chat messages WITHOUT resource data (ids only): the `resource` names a chat and a message. */
  notificationBody(items: { subscriptionId: string; clientState?: string; changeType?: string; resource?: string; lifecycleEvent?: string; tenantId?: string }[]): string;
  reset(): void;
}

export function createFakeTeamsSubscriptions(fake: FakeTeams): FakeTeamsSubscriptions {
  const subscriptions = new Map<string, FakeTeamsSubscription>();
  const requests: TeamsSubscriptionRequestRecord[] = [];
  const validations: FakeTeamsSubscriptions["validations"] = [];
  const fails: { key: TeamsSubscriptionFailKey; status: number; left: number }[] = [];
  let fixedNow: number | null = null;
  let seq = 0;
  const out: FakeTeamsSubscriptions = {
    handlers: [],
    subscriptions,
    requests,
    validations,
    validator: null,
    sawIncludeResourceData: 0,
    refuse: null,
    grantMinutes: null,
    failNext: (key, status, times = 1) => void fails.push({ key, status, left: times }),
    remove: (id) => void subscriptions.delete(id),
    setNow: (ms) => void (fixedNow = ms),
    now: () => fixedNow ?? Date.now(),
    notificationBody: (items) =>
      JSON.stringify({
        value: items.map((i) => ({
          subscriptionId: i.subscriptionId,
          subscriptionExpirationDateTime: new Date(out.now() + 3600_000).toISOString(),
          ...(i.clientState === undefined ? {} : { clientState: i.clientState }),
          tenantId: i.tenantId ?? "11111111-1111-4111-8111-111111111111",
          ...(i.lifecycleEvent
            ? { lifecycleEvent: i.lifecycleEvent }
            : { changeType: i.changeType ?? "created", resource: i.resource ?? "chats('19:synthetic-chat@thread.v2')/messages('1700000000000')", resourceData: { "@odata.type": "#Microsoft.Graph.chatMessage", id: "1700000000000" } }),
        })),
      }),
    reset() {
      subscriptions.clear();
      requests.length = 0;
      validations.length = 0;
      fails.length = 0;
      fixedNow = null;
      out.validator = null;
      out.sawIncludeResourceData = 0;
      out.refuse = null;
      out.grantMinutes = null;
    },
  };

  const gErr = (status: number, code: string) => HttpResponse.json({ error: { code, message: TEAMS_ERROR_TEXT_CANARY } }, { status, headers: { "request-id": `synthetic-ts-${String(++seq)}` } });
  const accountOf = (authorization: string | null): FakeTeamsAccount | undefined => {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    return [...fake.accounts.values()].find((x) => x.accessTokens.has(bearer));
  };
  async function admit(request: Request, key: TeamsSubscriptionFailKey): Promise<{ account: FakeTeamsAccount; body: unknown } | { response: Response }> {
    const account = accountOf(request.headers.get("authorization"));
    let body: unknown = undefined;
    if (request.method !== "GET") {
      const text = await request.clone().text();
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = text;
      }
    }
    requests.push({ method: request.method, path: new URL(request.url).pathname, body, upn: account?.upn ?? null });
    if (!account) return { response: gErr(401, "InvalidAuthenticationToken") };
    const f = fails.find((x) => x.key === key && x.left > 0);
    if (f) {
      f.left -= 1;
      return { response: gErr(f.status, "InjectedFailure") };
    }
    return { account, body };
  }
  const view = (s: FakeTeamsSubscription) => ({
    id: s.id,
    resource: s.resource,
    changeType: s.changeType,
    notificationUrl: s.notificationUrl,
    ...(s.lifecycleNotificationUrl ? { lifecycleNotificationUrl: s.lifecycleNotificationUrl } : {}),
    expirationDateTime: new Date(s.expirationDateTime).toISOString(),
    clientState: s.clientState,
  });
  /** The expiry Microsoft gives: what the test says it grants, else the request capped at 4,320 minutes. Null: not a date. */
  const granted = (raw: unknown): number | null => {
    const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (Number.isNaN(at)) return null;
    if (out.grantMinutes !== null) return out.now() + out.grantMinutes * 60_000;
    return Math.min(at, out.now() + 4_320 * 60_000);
  };
  const live = (id: string, account: FakeTeamsAccount): FakeTeamsSubscription | undefined => {
    const s = subscriptions.get(id);
    return s && s.account === account && s.expirationDateTime > out.now() ? s : undefined;
  };
  async function validate(url: string): Promise<boolean> {
    const token = `synthetic-validation-token-${randomUUID()}`;
    if (!out.validator) {
      validations.push({ url, token, ok: true });
      return true;
    }
    let ok = false;
    try {
      const res = await out.validator(url, token);
      ok = res.status === 200 && (res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/plain") && (await res.text()) === token;
    } catch {
      ok = false;
    }
    validations.push({ url, token, ok });
    return ok;
  }

  out.handlers = [
    http.post(`${GRAPH_V1}/subscriptions`, async ({ request }) => {
      const a = await admit(request, "create");
      if ("response" in a) return a.response;
      const b = (typeof a.body === "object" && a.body !== null ? a.body : {}) as Record<string, unknown>;
      if ("includeResourceData" in b) out.sawIncludeResourceData += 1;
      if (out.refuse) return gErr(out.refuse.status, out.refuse.code);
      const changes = typeof b.changeType === "string" ? b.changeType.split(",") : [];
      const resource = typeof b.resource === "string" ? b.resource : "";
      const notificationUrl = typeof b.notificationUrl === "string" ? b.notificationUrl : "";
      const lifecycle = typeof b.lifecycleNotificationUrl === "string" ? b.lifecycleNotificationUrl : null;
      const clientState = typeof b.clientState === "string" ? b.clientState : "";
      const expiry = granted(b.expirationDateTime);
      if (changes.length === 0 || !changes.every((c) => CHANGE_TYPES.has(c))) return gErr(400, "BadRequest");
      if (resource.replace(/^\//, "") !== `users/${a.account.objectId}/chats/getAllMessages`) return gErr(400, "ExtensionError");
      if (!notificationUrl.startsWith("https://") || lifecycle === null || !lifecycle.startsWith("https://")) return gErr(400, "ExtensionError"); // a lifecycle URL is required beyond 1 hour
      if (clientState.length > 128) return gErr(400, "BadRequest");
      if (expiry === null) return gErr(400, "BadRequest");
      if ([...subscriptions.values()].filter((s) => s.account === a.account && s.expirationDateTime > out.now()).length >= FAKE_TEAMS_MAX_ALL_CHATS_PER_USER) return gErr(403, "Forbidden");
      if (!(await validate(notificationUrl)) || !(await validate(lifecycle))) return gErr(400, "ValidationError");
      const s: FakeTeamsSubscription = { id: randomUUID(), account: a.account, resource, changeType: b.changeType as string, notificationUrl, lifecycleNotificationUrl: lifecycle, expirationDateTime: expiry, clientState };
      subscriptions.set(s.id, s);
      return HttpResponse.json(view(s), { status: 201, headers: { "request-id": `synthetic-ts-${String(++seq)}` } });
    }),
    http.patch(`${GRAPH_V1}/subscriptions/:id`, async ({ request, params }) => {
      const a = await admit(request, "renew");
      if ("response" in a) return a.response;
      const s = live(String(params.id), a.account);
      if (!s) return gErr(404, "ResourceNotFound");
      const b = (typeof a.body === "object" && a.body !== null ? a.body : {}) as Record<string, unknown>;
      if (Object.keys(b).some((k) => k !== "expirationDateTime")) return gErr(400, "BadRequest");
      const expiry = granted(b.expirationDateTime);
      if (expiry === null) return gErr(400, "BadRequest");
      s.expirationDateTime = expiry;
      return HttpResponse.json(view(s), { headers: { "request-id": `synthetic-ts-${String(++seq)}` } });
    }),
    http.delete(`${GRAPH_V1}/subscriptions/:id`, async ({ request, params }) => {
      const a = await admit(request, "delete");
      if ("response" in a) return a.response;
      const s = live(String(params.id), a.account);
      if (!s) return gErr(404, "ResourceNotFound");
      subscriptions.delete(s.id);
      return new HttpResponse(null, { status: 204, headers: { "request-id": `synthetic-ts-${String(++seq)}` } });
    }),
  ];
  return out;
}
