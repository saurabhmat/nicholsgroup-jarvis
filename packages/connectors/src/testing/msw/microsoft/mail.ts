// Fake Microsoft Graph mail (MSW) for the Microsoft mail sync tests (T-258): well-known folder lookup and per-folder `messages/delta`, over the same
// synthetic accounts as ./handlers.ts. Synthetic data only (rule 10). Faithful where the sync relies on Microsoft's documentation
// (docs/plan-review.md, "T-258: spec §15 verify items"):
//  - a delta request is per folder id; well-known names work for the folder lookup but NOT in the delta URL (404);
//  - `Prefer: IdType="ImmutableId"` is REQUIRED on every request, including a request made from a stored nextLink or deltaLink: the fake refuses
//    (400) a request without it, and records that it did;
//  - `$filter` is refused (a filtered delta returns at most 5,000 messages; the sync must not use it), `$orderby` may only be `receivedDateTime desc`;
//  - a link request carries the link's query as given; a page ends with exactly one of `@odata.nextLink` / `@odata.deltaLink`;
//  - a removed or moved-out message comes back as `{ id, "@removed": { reason: "deleted" } }` in the folder it left;
//  - an expired delta state answers 410 (or a 4xx with `syncStateNotFound` / `resyncRequired`);
//  - T-259: `GET /me/messages/{id}` (single message: `$select=body` and `$select=internetMessageHeaders`, the only way headers come back) and
//    `GET /me/messages?$search="..."` (a search: `$filter` and `$orderby` are refused with it; the answer is metadata only unless the fake is told to return a body anyway);
//  - the fake returns `body`, `bodyPreview`, `uniqueBody` and other fields the sync never selects (Graph may do so; the mapper must drop them).
// Every request is recorded (path, raw query, the Prefer header, the account) so a test can prove what was and was not sent.
import { HttpResponse, http, type RequestHandler } from "msw";
import { GRAPH_V1, MICROSOFT_ERROR_TEXT_CANARY, type FakeMicrosoft, type FakeMsAccount } from "./handlers";

export const MAIL_BODY_CANARY = "synthetic-graph-body-canary-4c19-not-real";
export const MAIL_PREVIEW_CANARY = "synthetic-graph-preview-canary-9a02-not-real";
export const DAY_MS = 86_400_000;
export const WELL_KNOWN = ["inbox", "sentitems", "archive", "drafts", "deleteditems", "junkemail"] as const;
export type FakeFolderName = (typeof WELL_KNOWN)[number];

export type FakeMailMessage = {
  id: string;
  conversationId: string;
  subject: string;
  from: { address: string; name: string };
  to: { address: string; name: string }[];
  cc: { address: string; name: string }[];
  receivedDateTime: string;
  sentDateTime: string;
  isRead: boolean;
  flagStatus: "notFlagged" | "complete" | "flagged";
  importance: "low" | "normal" | "high";
  hasAttachments: boolean;
  inferenceClassification: "focused" | "other";
  categories: string[];
  lastModifiedDateTime: string;
  webLink: string;
  /** The version counter value when it last changed (the delta cursor is a version). */
  changedAt: number;
  /** T-259: what a single-message read returns. Defaults: a text body holding the content canary, and a few ordinary headers. */
  bodyContentType?: string;
  bodyContent?: string;
  /** Header lines (`internetMessageHeaders`). Default: a Received line only. */
  headers?: { name: string; value: string }[];
  /** The `@odata.type` the delta item carries (default `#microsoft.graph.message`; `#microsoft.graph.eventMessage` for a meeting message). */
  odataType?: string;
};

type Box = { id: string; hidden?: boolean; name: FakeFolderName; messages: Map<string, FakeMailMessage>; removed: { id: string; at: number }[]; version: number };
export type MailFault = "auth_revoked" | "rate_limited" | "server_error" | "expired_cursor";
export type MailRequest = { method: string; path: string; search: string; prefer: string | null; address: string | null; kind: "folder" | "delta" | "message" | "search" | "other" };

export type FakeMailOptions = {
  /** The fake's idea of now (messages are dated relative to it). Default: a fixed 2026-11-05T12:00:00Z. */
  now?: () => number;
  /** Messages per page when the request has no `odata.maxpagesize`. Default 10. */
  defaultPageSize?: number;
  /** Return body fields on every message even though they are not selected (Graph may; the mapper must drop them). Default true. */
  returnBodiesAnyway?: boolean;
  /** How links name the folder: `slash` `/mailFolders/{id}/messages/delta`, `paren` `/mailFolders('{id}')/messages/delta`. Default slash. */
  linkStyle?: "slash" | "paren";
  /** Characters added to every token (long synthetic links). Default 0. */
  tokenPad?: number;
  /** Rewrites every nextLink / deltaLink the fake emits (tampered-link tests). */
  rewriteLink?: (link: string) => string;
};

export const FAKE_NOW = Date.parse("2026-11-05T12:00:00.000Z");

export interface FakeMail {
  handlers: RequestHandler[];
  requests: MailRequest[];
  /** Requests refused because the Prefer header lacked `IdType="ImmutableId"`. */
  refusedForImmutableId: number;
  options: Required<Pick<FakeMailOptions, "returnBodiesAnyway" | "linkStyle" | "tokenPad" | "defaultPageSize">> & Pick<FakeMailOptions, "rewriteLink">;
  /** The folder's Graph id for an account (the mailbox is created, with its seed, on first use). */
  folderId(account: FakeMsAccount, name: FakeFolderName): string;
  messages(account: FakeMsAccount, name: FakeFolderName): FakeMailMessage[];
  /** Adds a message (or replaces the one with that id, as a change). Returns its id. */
  add(account: FakeMsAccount, name: FakeFolderName, over?: Partial<Omit<FakeMailMessage, "changedAt">> & { ageDays?: number }): string;
  /** A message leaves its folder: the folder's delta reports `@removed`. Returns the id of the removed message (the OLDEST when none is named, so a message added in the same test is never the one removed). */
  remove(account: FakeMsAccount, name: FakeFolderName, id?: string): string;
  /** Moves a message (the same immutable id) to another folder: `@removed` in the old folder, an upsert in the new one. */
  move(account: FakeMsAccount, id: string, from: FakeFolderName, to: FakeFolderName): void;
  change(account: FakeMsAccount, name: FakeFolderName, id: string, patch: Partial<Omit<FakeMailMessage, "changedAt" | "id">>): void;
  setFault(account: FakeMsAccount, kind: MailFault, count?: number): void;
  /** The next `times` (default 1) link requests on this account answer this expired-state error (default 410, `syncStateNotFound`). */
  expireDeltaState(account: FakeMsAccount, how?: { status?: number; code?: string; times?: number }): void;
  /** The mailbox has no such folder (lookups and delta requests answer 404) until `showFolder`. */
  hideFolder(account: FakeMsAccount, name: FakeFolderName): void;
  showFolder(account: FakeMsAccount, name: FakeFolderName): void;
  /** The folder is deleted and created again: it gets a new id; the old id answers 404. Returns the new id. */
  recreateFolder(account: FakeMsAccount, name: FakeFolderName): string;
  /** Requests to the delta endpoint only. */
  deltaRequests(): MailRequest[];
  /** T-259: single-message reads (`GET /me/messages/{id}`) and searches, as recorded. */
  messageRequests(): MailRequest[];
  searchRequests(): MailRequest[];
  /** Every `$search` value the fake received, decoded (the quotes included), in order. */
  searchValues: string[];
  /** The ids of the messages the fake was asked for one by one, in order. */
  messageReads: { id: string; select: string | null; prefer: string | null }[];
  /** Called when a single-message read arrives, before it is answered (a test uses it to change the world between two reads). */
  onMessageRead: ((id: string) => void) | null;
  /** Make a single-message read of this id fail with this status (every time, until cleared with `null`). */
  failMessage(id: string, status: number | null): void;

}

const pageSizeOf = (prefer: string | null): number | null => {
  const m = /odata\.maxpagesize\s*=\s*(\d{1,5})/i.exec(prefer ?? "");
  return m ? Number(m[1]) : null;
};
const hasImmutable = (prefer: string | null): boolean => /(^|,)\s*IdType\s*=\s*"ImmutableId"\s*(,|$)/i.test(prefer ?? "");
const rawParams = (search: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (part === "") continue;
    const i = part.indexOf("=");
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
    const v = i < 0 ? "" : decodeURIComponent(part.slice(i + 1).replace(/\+/g, " "));
    out.set(k, v);
  }
  return out;
};

export function createFakeMail(fake: FakeMicrosoft, opts: FakeMailOptions = {}): FakeMail {
  const now = opts.now ?? (() => FAKE_NOW);
  const options = { returnBodiesAnyway: opts.returnBodiesAnyway ?? true, linkStyle: opts.linkStyle ?? "slash", tokenPad: opts.tokenPad ?? 0, defaultPageSize: opts.defaultPageSize ?? 10, ...(opts.rewriteLink ? { rewriteLink: opts.rewriteLink } : {}) };
  const boxes = new Map<FakeMsAccount, Map<FakeFolderName, Box>>();
  const faults = new Map<FakeMsAccount, { kind: MailFault; left: number }>();
  const expired = new Map<FakeMsAccount, { status: number; code: string; left: number }>();
  const requests: MailRequest[] = [];
  let refusedForImmutableId = 0;
  const searchValues: string[] = [];
  const messageReads: { id: string; select: string | null; prefer: string | null }[] = [];
  const failing = new Map<string, number>();
  let counter = 0;
  let accountCounter = 0;
  const accountNo = new Map<FakeMsAccount, number>();

  const mailbox = (a: FakeMsAccount): Map<FakeFolderName, Box> => {
    let m = boxes.get(a);
    if (m) return m;
    m = new Map();
    boxes.set(a, m);
    accountNo.set(a, ++accountCounter);
    for (const name of WELL_KNOWN) m.set(name, { id: `AAMkSyntheticFolder${name}${String(accountNo.get(a))}AAA=`, name, messages: new Map(), removed: [], version: 0 });
    // The seed of spec §17 test 11: 3 inbox and 2 sent messages.
    for (let k = 1; k <= 3; k++) add(a, "inbox", { subject: `Synthetic inbox ${String(k)}`, ageDays: k });
    for (let k = 1; k <= 2; k++) add(a, "sentitems", { subject: `Synthetic sent ${String(k)}`, ageDays: k });
    return m;
  };
  const box = (a: FakeMsAccount, name: FakeFolderName): Box => {
    const b = mailbox(a).get(name);
    if (!b) throw new Error("unknown fake folder");
    return b;
  };

  function add(a: FakeMsAccount, name: FakeFolderName, over: Partial<Omit<FakeMailMessage, "changedAt">> & { ageDays?: number } = {}): string {
    const b = (boxes.get(a) ?? mailbox(a)).get(name) as Box;
    const n = ++counter;
    const id = over.id ?? `AAMkSyntheticMessage${String(accountNo.get(a))}-${name}-${String(n)}=`;
    const at = new Date(now() - (over.ageDays ?? 0) * DAY_MS).toISOString();
    b.version += 1;
    const { ageDays: _ageDays, ...rest } = over;
    void _ageDays;
    b.messages.set(id, {
      id,
      conversationId: `synthetic-conversation-${String(n)}`,
      subject: `Synthetic message ${String(n)}`,
      from: { address: `sender${String(n)}@sender.example.test`, name: `Synthetic Sender ${String(n)}` },
      to: [{ address: a.address, name: "Synthetic Executive" }],
      cc: [],
      receivedDateTime: at,
      sentDateTime: at,
      isRead: false,
      flagStatus: "notFlagged",
      importance: "normal",
      hasAttachments: false,
      inferenceClassification: "focused",
      categories: [],
      lastModifiedDateTime: at,
      webLink: `https://outlook.office.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
      ...rest,
      changedAt: b.version,
    });
    b.removed = b.removed.filter((r) => r.id !== id); // a removed id that comes back is present again
    return id;
  }

  const token = (kind: "sk" | "dt", ...parts: (string | number)[]): string => `${kind}-${parts.join("-")}-${"Z".repeat(options.tokenPad)}Zm9v%3D%3D`;
  const linkFor = (b: Box, tokenName: "$skiptoken" | "$deltatoken", value: string): string => {
    const path = options.linkStyle === "paren" ? `${GRAPH_V1}/me/mailFolders('${b.id}')/messages/delta` : `${GRAPH_V1}/me/mailFolders/${b.id}/messages/delta`;
    const link = `${path}?${tokenName}=${value}`;
    return options.rewriteLink ? options.rewriteLink(link) : link;
  };

  const accountOf = (authorization: string | null): FakeMsAccount | undefined => {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    return [...fake.accounts.values()].find((x) => x.accessTokens.has(bearer));
  };
  // Graph error messages ECHO the bearer token here (and carry a canary text), so a leak into an error, a log or a record would show.
  let echoed = "";
  const gErr = (status: number, code: string, headers: Record<string, string> = {}) =>
    HttpResponse.json({ error: { code, message: `${echoed} ${MICROSOFT_ERROR_TEXT_CANARY}` } }, { status, headers: { "request-id": `synthetic-${String(++counter)}`, ...headers } });

  /** Auth, faults, throttling and the Prefer rule shared by both endpoints; a response to send, or the account. */
  function admit(request: Request, kind: MailRequest["kind"]): { account: FakeMsAccount } | { response: Response } {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    const account = accountOf(authorization);
    const prefer = request.headers.get("prefer");
    echoed = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    requests.push({ method: request.method, path: url.pathname, search: url.search, prefer, address: account?.address ?? null, kind });
    if (!account) return { response: gErr(401, "InvalidAuthenticationToken") };
    const f = faults.get(account);
    if (f && f.left > 0 && f.kind !== "expired_cursor") {
      f.left -= 1;
      if (f.kind === "auth_revoked") {
        account.revoked = true; // the refresh that follows the 401 is refused: reconnect_required
        return { response: gErr(401, "InvalidAuthenticationToken") };
      }
      if (f.kind === "rate_limited") return { response: gErr(429, "TooManyRequests", { "retry-after": "120" }) };
      return { response: gErr(500, "InternalServerError") };
    }
    const t = account.throttle;
    if (t && t.remaining > 0) {
      t.remaining -= 1;
      return { response: gErr(t.status, "TooManyRequests", t.retryAfter === null ? {} : { "retry-after": String(t.retryAfter) }) };
    }
    if (!hasImmutable(prefer)) {
      refusedForImmutableId += 1;
      return { response: gErr(400, "ImmutableIdRequired") };
    }
    return { account };
  }

  const indexFields = (m: FakeMailMessage): Record<string, unknown> => ({
    "@odata.type": m.odataType ?? "#microsoft.graph.message",
    id: m.id,
    conversationId: m.conversationId,
    webLink: m.webLink,
    from: { emailAddress: m.from },
    toRecipients: m.to.map((e) => ({ emailAddress: e })),
    ccRecipients: m.cc.map((e) => ({ emailAddress: e })),
    subject: m.subject,
    receivedDateTime: m.receivedDateTime,
    sentDateTime: m.sentDateTime,
    isRead: m.isRead,
    flag: { flagStatus: m.flagStatus },
    importance: m.importance,
    hasAttachments: m.hasAttachments,
    inferenceClassification: m.inferenceClassification,
    categories: m.categories,
    lastModifiedDateTime: m.lastModifiedDateTime,
        });
  /** Fields the sync never selects but Graph may return anyway; the strict mapper must drop them. */
  const addExtras = (out: Record<string, unknown>, m: FakeMailMessage): void => {
    out.body = { contentType: "text", content: `${MAIL_BODY_CANARY} ${m.id}` };
    out.bodyPreview = `${MAIL_PREVIEW_CANARY} ${m.id}`;
    out.uniqueBody = { contentType: "text", content: MAIL_BODY_CANARY };
    out.internetMessageHeaders = [{ name: "X-Synthetic", value: MAIL_BODY_CANARY }];
  };

  const handlers: RequestHandler[] = [
    // Folder lookup: a well-known name (or an id) -> the folder.
    http.get(`${GRAPH_V1}/me/mailFolders/:name`, ({ request, params }) => {
      const a = admit(request, "folder");
      if ("response" in a) return a.response;
      const name = decodeURIComponent(String(params.name));
      const b = [...mailbox(a.account).values()].find((x) => !x.hidden && (x.name === name || x.id === name));
      if (!b) return gErr(404, "ErrorItemNotFound");
      const select = rawParams(new URL(request.url).search).get("$select");
      return HttpResponse.json({ id: b.id, ...(select === undefined || select === "id" ? {} : { displayName: b.name }) }, { headers: { "request-id": `synthetic-${String(++counter)}` } });
    }),

    // T-259: one message (the only place Graph returns `internetMessageHeaders`, and the live body). `$select` is honoured: only what is selected comes back.
    http.get(`${GRAPH_V1}/me/messages/:id`, ({ request, params }) => {
      const a = admit(request, "message");
      if ("response" in a) return a.response;
      const id = decodeURIComponent(String(params.id));
      const q = rawParams(new URL(request.url).search);
      const select = q.get("$select") ?? null;
      messageReads.push({ id, select, prefer: request.headers.get("prefer") });
      api.onMessageRead?.(id);
      const status = failing.get(id);
      if (status !== undefined) return gErr(status, "InjectedFailure");
      const m = [...mailbox(a.account).values()].filter((x) => !x.hidden).flatMap((x) => [...x.messages.values()]).find((x) => x.id === id);
      if (!m) return gErr(404, "ErrorItemNotFound");
      const wanted = new Set((select ?? "id").split(",").map((x) => x.trim()));
      const out: Record<string, unknown> = { "@odata.context": `${GRAPH_V1}/$metadata#users('synthetic')/messages(id)`, id: m.id };
      if (wanted.has("body")) out.body = { contentType: m.bodyContentType ?? "text", content: m.bodyContent ?? `${MAIL_BODY_CANARY} ${m.id}` };
      if (wanted.has("internetMessageHeaders")) out.internetMessageHeaders = m.headers ?? [{ name: "Received", value: "from synthetic.example.test by synthetic.example.test" }];
      return HttpResponse.json(out, { headers: { "request-id": `synthetic-${String(++counter)}`, "preference-applied": 'outlook.body-content-type="text"' } });
    }),

    // T-259: search. `$search` is one quoted clause; Graph does not take `$filter` or `$orderby` with it. A message matches when EVERY word of the clause is in its
    // subject or sender (the fake has no operators: a query that is still a boolean one would only be reduced by what the sync sent).
    http.get(`${GRAPH_V1}/me/messages`, ({ request }) => {
      const a = admit(request, "search");
      if ("response" in a) return a.response;
      const q = rawParams(new URL(request.url).search);
      const clause = q.get("$search");
      if (clause === undefined) return gErr(400, "SearchRequired");
      searchValues.push(clause);
      if (q.has("$filter") || q.has("$orderby")) return gErr(400, "SearchCannotCombine");
      if (!/^"[^"\\]*"$/.test(clause)) return gErr(400, "InvalidSearchClause"); // the whole clause in one pair of quotes, no quote or backslash inside
      const words = clause.slice(1, -1).toLowerCase().split(/\s+/).filter(Boolean);
      const top = Number(q.get("$top") ?? "25");
      const hits = [...mailbox(a.account).values()]
        .filter((x) => !x.hidden)
        .flatMap((x) => [...x.messages.values()])
        .filter((m) => words.every((w) => `${m.subject} ${m.from.address} ${m.from.name}`.toLowerCase().includes(w)))
        .sort((x, y) => (x.receivedDateTime < y.receivedDateTime ? 1 : -1))
        .slice(0, Number.isFinite(top) && top > 0 ? top : 25);
      const value = hits.map((m) => {
        const out = indexFields(m);
        if (options.returnBodiesAnyway) addExtras(out, m);
        return out;
      });
      return HttpResponse.json({ "@odata.context": `${GRAPH_V1}/$metadata#users('synthetic')/messages`, value }, { headers: { "request-id": `synthetic-${String(++counter)}` } });
    }),

    http.get(`${GRAPH_V1}/me/mailFolders/:id/messages/delta`, ({ request, params }) => {
      const a = admit(request, "delta");
      if ("response" in a) return a.response;
      const account = a.account;
      const id = decodeURIComponent(String(params.id));
      const b = [...mailbox(account).values()].find((x) => !x.hidden && x.id === id); // ids only: well-known names do not work in a delta URL
      if (!b) return gErr(404, "ErrorItemNotFound");
      const url = new URL(request.url);
      const q = rawParams(url.search);
      if (q.has("$filter")) return gErr(400, "FilterNotAcceptedByFake"); // the sync must not use it (5,000-message cap)
      const order = q.get("$orderby");
      if (order !== undefined && order.replace(/\s+/g, " ").trim().toLowerCase() !== "receiveddatetime desc") return gErr(400, "InvalidOrderBy");
      const skip = /[?&]\$skiptoken=([^&]*)/.exec(url.search)?.[1];
      const delta = /[?&]\$deltatoken=([^&]*)/.exec(url.search)?.[1];
      const isLink = skip !== undefined || delta !== undefined;
      const f = faults.get(account);
      const ex = expired.get(account);
      if (isLink && ex && ex.left > 0) {
        ex.left -= 1;
        return gErr(ex.status, ex.code, ex.status === 410 ? { location: `${GRAPH_V1}/me/mailFolders/${b.id}/messages/delta?$deltatoken=` } : {});
      }
      if (isLink && f && f.left > 0 && f.kind === "expired_cursor") {
        f.left -= 1;
        return gErr(410, "syncStateNotFound");
      }
      const size = pageSizeOf(request.headers.get("prefer")) ?? options.defaultPageSize;
      // What this request lists: the whole folder newest first (initial), or what changed since a version.
      let mode: "i" | "d" = "i";
      let base = 0;
      let offset = 0;
      if (skip !== undefined) {
        const m = /^sk-(i|d)-(\d+)-(\d+)-/.exec(skip);
        if (!m) return gErr(400, "InvalidSkipToken");
        mode = m[1] as "i" | "d";
        base = Number(m[2]);
        offset = Number(m[3]);
      } else if (delta !== undefined) {
        const m = /^dt-(\d+)-/.exec(delta);
        if (!m) return gErr(400, "InvalidDeltaToken");
        mode = "d";
        base = Number(m[1]);
      }
      type Item = { msg?: FakeMailMessage; removedId?: string };
      let items: Item[];
      if (mode === "i") items = [...b.messages.values()].sort((x, y) => (x.receivedDateTime < y.receivedDateTime ? 1 : x.receivedDateTime > y.receivedDateTime ? -1 : x.id < y.id ? 1 : -1)).map((msg) => ({ msg }));
      else items = [...[...b.messages.values()].filter((m) => m.changedAt > base).sort((x, y) => x.changedAt - y.changedAt).map((msg) => ({ msg })), ...b.removed.filter((r) => r.at > base).map((r) => ({ removedId: r.id }))];
      const slice = items.slice(offset, offset + size);
      const value = slice.map((it) => {
        if (it.removedId !== undefined) return { "@odata.type": "#microsoft.graph.message", id: it.removedId, "@removed": { reason: "deleted" } };
        const m = it.msg as FakeMailMessage;
        const out = indexFields(m);
        if (options.returnBodiesAnyway) addExtras(out, m);
        return out;
      });
      const more = offset + size < items.length;
      const page: Record<string, unknown> = { "@odata.context": `${GRAPH_V1}/$metadata#Collection(message)`, value };
      if (more) page["@odata.nextLink"] = linkFor(b, "$skiptoken", token("sk", mode, base, offset + size));
      else page["@odata.deltaLink"] = linkFor(b, "$deltatoken", token("dt", b.version));
      return HttpResponse.json(page, { headers: { "request-id": `synthetic-${String(++counter)}` } });
    }),
  ];

  const api: FakeMail = {
    onMessageRead: null,
    handlers,
    requests,
    get refusedForImmutableId() {
      return refusedForImmutableId;
    },
    options,
    folderId: (a, name) => box(a, name).id,
    messages: (a, name) => [...box(a, name).messages.values()],
    add: (a, name, over) => {
      mailbox(a);
      return add(a, name, over);
    },
    remove(a, name, id) {
      const b = box(a, name);
      const target = id ?? [...b.messages.values()].sort((x, y) => (x.receivedDateTime < y.receivedDateTime ? -1 : 1))[0]?.id;
      if (target === undefined || !b.messages.delete(target)) throw new Error("no such fake message");
      b.version += 1;
      b.removed.push({ id: target, at: b.version });
      return target;
    },
    move(a, id, from, to) {
      const src = box(a, from);
      const m = src.messages.get(id);
      if (!m) throw new Error("no such fake message");
      src.messages.delete(id);
      src.version += 1;
      src.removed.push({ id, at: src.version });
      const dst = box(a, to);
      dst.version += 1;
      dst.messages.set(id, { ...m, lastModifiedDateTime: new Date(now()).toISOString(), changedAt: dst.version });
      dst.removed = dst.removed.filter((r) => r.id !== id);
    },
    change(a, name, id, patch) {
      const b = box(a, name);
      const m = b.messages.get(id);
      if (!m) throw new Error("no such fake message");
      b.version += 1;
      b.messages.set(id, { ...m, ...patch, lastModifiedDateTime: patch.lastModifiedDateTime ?? new Date(now()).toISOString(), changedAt: b.version });
    },
    setFault(a, kind, count = 1) {
      faults.set(a, { kind, left: kind === "server_error" ? Math.max(count, 2) : count });
    },
    expireDeltaState(a, how = {}) {
      expired.set(a, { status: how.status ?? 410, code: how.code ?? "syncStateNotFound", left: how.times ?? 1 });
    },
    hideFolder: (a, name) => void (box(a, name).hidden = true),
    showFolder: (a, name) => void (box(a, name).hidden = false),
    recreateFolder(a, name) {
      const b = box(a, name);
      b.id = `${b.id.replace(/AAA=$/, "")}R${String(++counter)}AAA=`;
      return b.id;
    },
    deltaRequests: () => requests.filter((r) => r.kind === "delta"),
    messageRequests: () => requests.filter((r) => r.kind === "message"),
    searchRequests: () => requests.filter((r) => r.kind === "search"),
    searchValues,
    messageReads,
    failMessage(id, status) {
      if (status === null) failing.delete(id);
      else failing.set(id, status);
    },
  };
  return api;
}

/** Default handlers: none (a test builds its own fake). */
export const handlers: RequestHandler[] = [];
