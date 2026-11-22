// Fake Microsoft Graph SUBSCRIPTION endpoints (MSW) for the change-notification tests (T-068, T-264). Synthetic data only (rule 10). Faithful to Microsoft's documentation as checked on
// Nov 22, 2026 (docs/plan-review.md, "T-262/T-263 and T-068/T-264: spec §15 verify items", V-21):
//  - `POST /subscriptions` validates the callback URL DURING the request: Graph POSTs `<url>?validationToken=<token>` and requires 200, `text/plain`, the decoded token (the test points
//    `validator` at the real receiver); `lifecycleNotificationUrl` is validated the same way; a failed validation answers 400 and creates nothing;
//  - `clientState` is at most 128 characters, `notificationUrl` is https, the resource is `me/mailfolders('inbox')/messages` or `me/events` (anything else 400), `changeType` is a
//    comma list of created, updated, deleted;
//  - the expiry may be at most 10,080 minutes ahead (400 above that) and a value under 45 minutes is raised to 45 (the answer shows the value Graph used);
//  - `includeResourceData` is accepted by the fake only to RECORD that it was sent (a test expects it never is);
//  - `PATCH /subscriptions/{id}` takes `expirationDateTime` only and answers the subscription; `DELETE` answers 204; an unknown, deleted or expired id answers 404 `ResourceNotFound`;
//  - the bearer token decides which account owns a subscription; another account's id answers 404 (Graph does not reveal it).
// Every request is recorded (method, path, parsed body, the account's address). `failNext` answers an error before applying anything; `expireNow(id)` and `remove(id)` model Graph ending a
// subscription. The clock is injectable (`setNow`), so renewal tests do not wait.
import { randomUUID } from "node:crypto";
import { HttpResponse, http, type RequestHandler } from "msw";
import { GRAPH_V1, MICROSOFT_ERROR_TEXT_CANARY, type FakeMicrosoft, type FakeMsAccount } from "./handlers";

export const FAKE_SUBSCRIPTION_MAX_MINUTES = 10_080;
export const FAKE_SUBSCRIPTION_MIN_MINUTES = 45;
export const FAKE_VALID_RESOURCES = ["me/mailfolders('inbox')/messages", "me/events"] as const;
const CHANGE_TYPES = new Set(["created", "updated", "deleted"]);

export type FakeSubscription = {
  id: string;
  account: FakeMsAccount;
  resource: string;
  changeType: string;
  notificationUrl: string;
  lifecycleNotificationUrl: string | null;
  expirationDateTime: number;
  clientState: string;
};
export type SubscriptionRequest = { method: string; path: string; body: unknown; address: string | null };
export type SubscriptionFailKey = "create" | "renew" | "delete";

/** Called for each URL Graph would validate: returns the receiver's answer to `POST <url>?validationToken=<token>`. */
export type ValidationCall = (url: string, token: string) => Promise<Response>;

export interface FakeSubscriptions {
  handlers: RequestHandler[];
  subscriptions: Map<string, FakeSubscription>;
  requests: SubscriptionRequest[];
  /** URLs Graph posted a validation token to, in order. */
  validations: { url: string; token: string; ok: boolean }[];
  /** How Graph reaches the receiver during creation. Default: accepts without calling anything (a test that is not about validation). */
  validator: ValidationCall | null;
  /** Fields of a create body the fake saw that a test expects NEVER to be sent. */
  sawIncludeResourceData: number;
  failNext(key: SubscriptionFailKey, status: number, times?: number): void;
  /** Graph ends the subscription (it then answers 404 for it). */
  remove(id: string): void;
  /** Sets the fake's clock (a number of ms since the epoch); the real clock when never called. */
  setNow(ms: number): void;
  now(): number;
  /** A change-notification collection body as Graph sends it (no resource data). */
  notificationBody(items: { subscriptionId: string; clientState?: string; changeType?: string; resource?: string; lifecycleEvent?: string }[]): string;
  reset(): void;
}

export function createFakeSubscriptions(fake: FakeMicrosoft): FakeSubscriptions {
  const subscriptions = new Map<string, FakeSubscription>();
  const requests: SubscriptionRequest[] = [];
  const validations: FakeSubscriptions["validations"] = [];
  const fails: { key: SubscriptionFailKey; status: number; left: number }[] = [];
  let fixedNow: number | null = null;
  let seq = 0;
  const out: FakeSubscriptions = {
    handlers: [],
    subscriptions,
    requests,
    validations,
    validator: null,
    sawIncludeResourceData: 0,
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
          tenantId: "11111111-1111-4111-8111-111111111111",
          ...(i.lifecycleEvent
            ? { lifecycleEvent: i.lifecycleEvent }
            : { changeType: i.changeType ?? "created", resource: i.resource ?? "Users/synthetic-user/Messages/synthetic-message", resourceData: { "@odata.type": "#Microsoft.Graph.Message", id: "synthetic-message" } }),
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
    },
  };

  const gErr = (status: number, code: string) => HttpResponse.json({ error: { code, message: MICROSOFT_ERROR_TEXT_CANARY } }, { status, headers: { "request-id": `synthetic-s-${String(++seq)}` } });
  const accountOf = (authorization: string | null): FakeMsAccount | undefined => {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    return [...fake.accounts.values()].find((x) => x.accessTokens.has(bearer));
  };
  async function admit(request: Request, key: SubscriptionFailKey): Promise<{ account: FakeMsAccount; body: unknown } | { response: Response }> {
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
    requests.push({ method: request.method, path: new URL(request.url).pathname, body, address: account?.address ?? null });
    if (!account) return { response: gErr(401, "InvalidAuthenticationToken") };
    const f = fails.find((x) => x.key === key && x.left > 0);
    if (f) {
      f.left -= 1;
      return { response: gErr(f.status, "InjectedFailure") };
    }
    return { account, body };
  }
  const view = (s: FakeSubscription) => ({
    id: s.id,
    resource: s.resource,
    changeType: s.changeType,
    notificationUrl: s.notificationUrl,
    ...(s.lifecycleNotificationUrl ? { lifecycleNotificationUrl: s.lifecycleNotificationUrl } : {}),
    expirationDateTime: new Date(s.expirationDateTime).toISOString(),
    clientState: s.clientState,
  });
  /** The expiry Graph uses: raised to 45 minutes when shorter; refused (null) when beyond the maximum. */
  const effectiveExpiry = (raw: unknown): number | null => {
    const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (Number.isNaN(at)) return null;
    const minutes = (at - out.now()) / 60_000;
    if (minutes > FAKE_SUBSCRIPTION_MAX_MINUTES) return null;
    return minutes < FAKE_SUBSCRIPTION_MIN_MINUTES ? out.now() + FAKE_SUBSCRIPTION_MIN_MINUTES * 60_000 : at;
  };
  const live = (id: string, account: FakeMsAccount): FakeSubscription | undefined => {
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
      const changes = typeof b.changeType === "string" ? b.changeType.split(",") : [];
      const resource = typeof b.resource === "string" ? b.resource : "";
      const notificationUrl = typeof b.notificationUrl === "string" ? b.notificationUrl : "";
      const lifecycle = typeof b.lifecycleNotificationUrl === "string" ? b.lifecycleNotificationUrl : null;
      const clientState = typeof b.clientState === "string" ? b.clientState : "";
      const expiry = effectiveExpiry(b.expirationDateTime);
      if (changes.length === 0 || !changes.every((c) => CHANGE_TYPES.has(c))) return gErr(400, "BadRequest");
      if (!(FAKE_VALID_RESOURCES as readonly string[]).includes(resource)) return gErr(400, "ExtensionError");
      if (!notificationUrl.startsWith("https://") || (lifecycle !== null && !lifecycle.startsWith("https://"))) return gErr(400, "ExtensionError");
      if (clientState.length > 128) return gErr(400, "BadRequest");
      if (expiry === null) return gErr(400, "BadRequest");
      if (!(await validate(notificationUrl)) || (lifecycle !== null && !(await validate(lifecycle)))) return gErr(400, "ValidationError");
      const s: FakeSubscription = { id: randomUUID(), account: a.account, resource, changeType: b.changeType as string, notificationUrl, lifecycleNotificationUrl: lifecycle, expirationDateTime: expiry, clientState };
      subscriptions.set(s.id, s);
      return HttpResponse.json(view(s), { status: 201, headers: { "request-id": `synthetic-s-${String(++seq)}` } });
    }),
    http.patch(`${GRAPH_V1}/subscriptions/:id`, async ({ request, params }) => {
      const a = await admit(request, "renew");
      if ("response" in a) return a.response;
      const s = live(String(params.id), a.account);
      if (!s) return gErr(404, "ResourceNotFound");
      const b = (typeof a.body === "object" && a.body !== null ? a.body : {}) as Record<string, unknown>;
      if (Object.keys(b).some((k) => k !== "expirationDateTime")) return gErr(400, "BadRequest");
      const expiry = effectiveExpiry(b.expirationDateTime);
      if (expiry === null) return gErr(400, "BadRequest");
      s.expirationDateTime = expiry;
      return HttpResponse.json(view(s), { headers: { "request-id": `synthetic-s-${String(++seq)}` } });
    }),
    http.delete(`${GRAPH_V1}/subscriptions/:id`, async ({ request, params }) => {
      const a = await admit(request, "delete");
      if ("response" in a) return a.response;
      const s = live(String(params.id), a.account);
      if (!s) return gErr(404, "ResourceNotFound");
      subscriptions.delete(s.id);
      return new HttpResponse(null, { status: 204, headers: { "request-id": `synthetic-s-${String(++seq)}` } });
    }),
  ];
  return out;
}
