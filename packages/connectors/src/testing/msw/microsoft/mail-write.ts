// Fake Microsoft Graph mail WRITE side (MSW) for the Microsoft email writer tests (T-262, T-263). Synthetic data only (rule 10). A mailbox per fake account with three
// folders (inbox, drafts, sentitems) and the four routes the writer may use, faithful to Microsoft's documentation as checked on Nov 22, 2026 (docs/plan-review.md,
// "T-262/T-263 and T-068/T-264: spec §15 verify items", V-19, V-20):
//  - `internetMessageHeaders` are accepted ONLY on `POST /me/messages` (create); on a PATCH they answer 400 (V-19: custom headers can be set only when a message is created);
//  - the single-value extended property (id form `String {guid} Name <name>`) can be set at create and by PATCH on a draft; a PATCH of a message that is not a draft is 400;
//  - `createReply`: 201 with the draft; the body is either `comment` or `message`, both is 400; the draft is in the parent's conversation, addressed to its sender;
//  - the marker filter is EXACTLY `singleValueExtendedProperties/Any(ep: ep/id eq '<id>' and ep/value eq '<value>')` on `/me/mailFolders/{name}/messages`, with at most
//    `$select` and `$top`: any other clause, `$orderby` or `$skip` is 400 (not documented to combine). The property is read back only with the `$expand` form;
//  - `POST /me/messages/{id}/send`: 202, empty body; the message moves to Sent Items and stops being a draft; its Sent Items copy appears only after `sentLag`
//    marker lookups of Sent Items ("might not succeed immediately"); with `Prefer: IdType="ImmutableId"` the id does not change on the move (the fake can change it: `idChangesOnSend`);
//  - EVERY request must carry `Prefer: IdType="ImmutableId"` (else 400) and a bearer token of the account.
// Faults: `crashAfterSend` applies the send and then drops the connection (the writer sees a network failure); `serverErrorAfterSend` applies it and answers 503; `failNext`
// answers an error (status) before applying anything. Every request is recorded (method, path, query, headers of interest, parsed JSON body); counters say how many
// messages were created and sent. Any other method + path answers 405 and is recorded in `unexpected` (a test expects it to stay empty).
import { HttpResponse, http, type RequestHandler } from "msw";
import { GRAPH_V1, MICROSOFT_ERROR_TEXT_CANARY, type FakeMicrosoft, type FakeMsAccount } from "./handlers";

export const WRITE_FAKE_FOLDERS = ["inbox", "drafts", "sentitems"] as const;
export type WriteFolder = (typeof WRITE_FAKE_FOLDERS)[number];
type Addr = { emailAddress: { address: string; name?: string } };

export type FakeWriteMessage = {
  id: string;
  folder: WriteFolder;
  conversationId: string;
  subject: string;
  from: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  bodyContent: string;
  bodyContentType: string;
  isDraft: boolean;
  /** Extended properties by id. */
  props: Map<string, string>;
  /** `internetMessageHeaders` set at create. */
  headers: { name: string; value: string }[];
  /** How many Sent Items marker lookups still hide this message (a sent copy that is not there yet). */
  hiddenLookups: number;
};

export type WriteRequest = { method: string; path: string; search: string; prefer: string | null; body: unknown; address: string | null; hadAuthorization: boolean };
export type WriteFault = "crashAfterSend" | "serverErrorAfterSend";

export interface FakeMailWrite {
  handlers: RequestHandler[];
  requests: WriteRequest[];
  /** Requests on routes the fake does not serve (a test expects []). */
  unexpected: WriteRequest[];
  counts: { created: number; replies: number; patched: number; sent: number };
  /** Messages of the mailbox (all folders). */
  messages(account: FakeMsAccount): FakeWriteMessage[];
  inFolder(account: FakeMsAccount, folder: WriteFolder): FakeWriteMessage[];
  /** Puts a message in the inbox (or another folder). Returns it. */
  seed(account: FakeMsAccount, over: Partial<FakeWriteMessage> & { id: string; conversationId: string }): FakeWriteMessage;
  /** The next `n` Sent Items marker lookups find nothing yet for a message that was just sent. Default 0. */
  sentLag: number;
  /** After a send the message gets a new id (a mailbox that ignores the ImmutableId preference). */
  idChangesOnSend: boolean;
  /** The next send is applied and then fails this way, once. */
  faultAfterSend: WriteFault | null;
  /** The next request whose "method path-kind" key matches answers this status BEFORE applying anything, `times` times (default 1). Keys: `create`, `createReply`, `patch`, `send`, `lookup`, `read`. */
  failNext(key: "create" | "createReply" | "patch" | "send" | "lookup" | "read", status: number, times?: number): void;
  /** Clears every mailbox, the request log, the counters and the injected faults (a test calls it before it seeds). */
  reset(): void;
  /** A person edits a draft in Outlook (changes its body). */
  editBody(account: FakeMsAccount, id: string, content: string): void;
}

const MARKER_FILTER = /^singleValueExtendedProperties\/Any\(ep: ep\/id eq '([^']+)' and ep\/value eq '([^']+)'\)$/;
const hasImmutable = (prefer: string | null): boolean => /(^|,)\s*IdType\s*=\s*"ImmutableId"\s*(,|$)/i.test(prefer ?? "");

export function createFakeMailWrite(fake: FakeMicrosoft): FakeMailWrite {
  const boxes = new Map<FakeMsAccount, Map<string, FakeWriteMessage>>();
  const requests: WriteRequest[] = [];
  const unexpected: WriteRequest[] = [];
  const counts = { created: 0, replies: 0, patched: 0, sent: 0 };
  const fails: { key: string; status: number; left: number }[] = [];
  let seq = 0;
  let echoed = "";

  const box = (a: FakeMsAccount) => {
    let m = boxes.get(a);
    if (!m) boxes.set(a, (m = new Map()));
    return m;
  };
  const gErr = (status: number, code: string) => HttpResponse.json({ error: { code, message: `${echoed} ${MICROSOFT_ERROR_TEXT_CANARY}` } }, { status, headers: { "request-id": `synthetic-w-${String(++seq)}` } });
  const accountOf = (authorization: string | null): FakeMsAccount | undefined => {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    return [...fake.accounts.values()].find((x) => x.accessTokens.has(bearer));
  };
  const record = async (request: Request, account: FakeMsAccount | undefined, into = requests): Promise<WriteRequest> => {
    const url = new URL(request.url);
    let body: unknown = undefined;
    if (request.method !== "GET") {
      const text = await request.clone().text();
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const r: WriteRequest = { method: request.method, path: url.pathname, search: url.search, prefer: request.headers.get("prefer"), body, address: account?.address ?? null, hadAuthorization: request.headers.has("authorization") };
    into.push(r);
    return r;
  };
  /** Auth, the Prefer rule and the injected failures shared by every route; a response to send, or the account. */
  async function admit(request: Request, key: string): Promise<{ account: FakeMsAccount; req: WriteRequest } | { response: Response }> {
    const authorization = request.headers.get("authorization");
    const account = accountOf(authorization);
    echoed = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const req = await record(request, account);
    if (!account) return { response: gErr(401, "InvalidAuthenticationToken") };
    const f = fails.find((x) => x.key === key && x.left > 0);
    if (f) {
      f.left -= 1;
      return { response: gErr(f.status, "InjectedFailure") };
    }
    if (!hasImmutable(req.prefer)) return { response: gErr(400, "ImmutableIdRequired") };
    return { account, req };
  }

  const out = (m: FakeWriteMessage, wanted: Set<string> | null, expand: string | null): Record<string, unknown> => {
    const all: Record<string, unknown> = {
      id: m.id,
      conversationId: m.conversationId,
      subject: m.subject,
      isDraft: m.isDraft,
      from: { emailAddress: { address: m.from, name: "Synthetic Executive" } },
      toRecipients: m.to,
      ccRecipients: m.cc,
      bccRecipients: m.bcc,
      body: { contentType: m.bodyContentType, content: m.bodyContent },
      parentFolderId: `folder-${m.folder}`,
    };
    const res: Record<string, unknown> = {};
    for (const k of Object.keys(all)) if (wanted === null || wanted.has(k) || k === "id") res[k] = all[k];
    if (expand) {
      const id = /id eq '([^']+)'/.exec(expand)?.[1];
      const v = id ? m.props.get(id) : undefined;
      res.singleValueExtendedProperties = id && v !== undefined ? [{ id, value: v }] : [];
    }
    return res;
  };
  const rcpts = (v: unknown): Addr[] => (Array.isArray(v) ? (v as Addr[]) : []);
  const parseQuery = (search: string): Map<string, string> => {
    const q = new Map<string, string>();
    for (const part of search.replace(/^\?/, "").split("&")) {
      if (part === "") continue;
      const i = part.indexOf("=");
      q.set(decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " ")), i < 0 ? "" : decodeURIComponent(part.slice(i + 1).replace(/\+/g, " ")));
    }
    return q;
  };
  const find = (a: FakeMsAccount, id: string) => [...box(a).values()].find((m) => m.id === id);

  const handlers: RequestHandler[] = [
    // Read one message (the parent, a draft, the read-back).
    http.get(`${GRAPH_V1}/me/messages/:id`, async ({ request, params }) => {
      const a = await admit(request, "read");
      if ("response" in a) return a.response;
      const m = find(a.account, decodeURIComponent(String(params.id)));
      if (!m) return gErr(404, "ErrorItemNotFound");
      const q = parseQuery(a.req.search);
      const sel = q.get("$select");
      return HttpResponse.json(out(m, sel ? new Set(sel.split(",").map((x) => x.trim())) : null, q.get("$expand") ?? null), { headers: { "request-id": `synthetic-w-${String(++seq)}` } });
    }),

    // The marker lookup in one folder: EXACTLY the documented filter (+ $select, $top).
    http.get(`${GRAPH_V1}/me/mailFolders/:folder/messages`, async ({ request, params }) => {
      const a = await admit(request, "lookup");
      if ("response" in a) return a.response;
      const folder = decodeURIComponent(String(params.folder)) as WriteFolder;
      if (!WRITE_FAKE_FOLDERS.includes(folder)) return gErr(404, "ErrorItemNotFound");
      const q = parseQuery(a.req.search);
      for (const k of q.keys()) if (!["$filter", "$select", "$top"].includes(k)) return gErr(400, "UnsupportedCombination");
      const f = MARKER_FILTER.exec(q.get("$filter") ?? "");
      if (!f) return gErr(400, "InvalidFilter");
      const [, propId, value] = f as unknown as [string, string, string];
      let hits = [...box(a.account).values()].filter((m) => m.folder === folder && m.props.get(propId) === value);
      if (folder === "sentitems") {
        hits = hits.filter((m) => {
          if (m.hiddenLookups > 0) {
            m.hiddenLookups -= 1;
            return false;
          }
          return true;
        });
      }
      const sel = q.get("$select");
      const wanted = sel ? new Set(sel.split(",").map((x) => x.trim())) : null;
      return HttpResponse.json({ value: hits.slice(0, Number(q.get("$top") ?? "10")).map((m) => out(m, wanted, null)) }, { headers: { "request-id": `synthetic-w-${String(++seq)}` } });
    }),

    // Create a draft (a new message).
    http.post(`${GRAPH_V1}/me/messages`, async ({ request }) => {
      const a = await admit(request, "create");
      if ("response" in a) return a.response;
      const b = (a.req.body ?? {}) as Record<string, unknown>;
      const id = `AAMkWriteMsg-${String(++seq)}=`;
      const props = new Map<string, string>();
      for (const p of (b.singleValueExtendedProperties as { id: string; value: string }[] | undefined) ?? []) props.set(p.id, p.value);
      const body = (b.body ?? {}) as { contentType?: string; content?: string };
      const m: FakeWriteMessage = {
        id, folder: "drafts", conversationId: `conv-new-${String(seq)}`, subject: String(b.subject ?? ""), from: a.account.address, to: rcpts(b.toRecipients), cc: rcpts(b.ccRecipients), bcc: rcpts(b.bccRecipients),
        bodyContent: body.content ?? "", bodyContentType: body.contentType ?? "text", isDraft: true, props, headers: (b.internetMessageHeaders as { name: string; value: string }[] | undefined) ?? [], hiddenLookups: 0,
      };
      box(a.account).set(id, m);
      counts.created += 1;
      return HttpResponse.json(out(m, null, null), { status: 201, headers: { "request-id": `synthetic-w-${String(++seq)}` } });
    }),

    http.post(`${GRAPH_V1}/me/messages/:id/createReply`, async ({ request, params }) => {
      const a = await admit(request, "createReply");
      if ("response" in a) return a.response;
      const parent = find(a.account, decodeURIComponent(String(params.id)));
      if (!parent) return gErr(404, "ErrorItemNotFound");
      const b = (a.req.body ?? {}) as Record<string, unknown>;
      if (b.comment !== undefined && b.message !== undefined) return gErr(400, "ErrorInvalidRequest"); // both is a 400 (V-20)
      const id = `AAMkWriteReply-${String(++seq)}=`;
      const m: FakeWriteMessage = {
        id, folder: "drafts", conversationId: parent.conversationId, subject: `RE: ${parent.subject}`, from: a.account.address, to: [{ emailAddress: { address: parent.from } }], cc: [], bcc: [],
        bodyContent: `quoted parent text`, bodyContentType: "html", isDraft: true, props: new Map(), headers: [], hiddenLookups: 0,
      };
      box(a.account).set(id, m);
      counts.replies += 1;
      return HttpResponse.json(out(m, null, null), { status: 201, headers: { "request-id": `synthetic-w-${String(++seq)}` } });
    }),

    http.patch(`${GRAPH_V1}/me/messages/:id`, async ({ request, params }) => {
      const a = await admit(request, "patch");
      if ("response" in a) return a.response;
      const m = find(a.account, decodeURIComponent(String(params.id)));
      if (!m) return gErr(404, "ErrorItemNotFound");
      if (!m.isDraft) return gErr(400, "ErrorInvalidRequest"); // only a draft can be updated
      const b = (a.req.body ?? {}) as Record<string, unknown>;
      if (b.internetMessageHeaders !== undefined) return gErr(400, "ErrorInvalidRequest"); // headers only at create (V-19)
      if (b.toRecipients !== undefined) m.to = rcpts(b.toRecipients);
      if (b.ccRecipients !== undefined) m.cc = rcpts(b.ccRecipients);
      if (b.bccRecipients !== undefined) m.bcc = rcpts(b.bccRecipients);
      if (typeof b.subject === "string") m.subject = b.subject;
      const body = b.body as { contentType?: string; content?: string } | undefined;
      if (body) {
        m.bodyContent = body.content ?? "";
        m.bodyContentType = body.contentType ?? "text";
      }
      for (const p of (b.singleValueExtendedProperties as { id: string; value: string }[] | undefined) ?? []) m.props.set(p.id, p.value);
      counts.patched += 1;
      return HttpResponse.json(out(m, null, null), { headers: { "request-id": `synthetic-w-${String(++seq)}` } });
    }),

    http.post(`${GRAPH_V1}/me/messages/:id/send`, async ({ request, params }) => {
      const a = await admit(request, "send");
      if ("response" in a) return a.response;
      const m = find(a.account, decodeURIComponent(String(params.id)));
      if (!m || !m.isDraft) return gErr(404, "ErrorItemNotFound");
      // Applied: the message leaves Drafts for Sent Items.
      m.isDraft = false;
      m.folder = "sentitems";
      m.hiddenLookups = api.sentLag;
      if (api.idChangesOnSend) {
        box(a.account).delete(m.id);
        m.id = `${m.id}-sent`;
        box(a.account).set(m.id, m);
      }
      counts.sent += 1;
      const fault = api.faultAfterSend;
      api.faultAfterSend = null;
      if (fault === "crashAfterSend") return HttpResponse.error();
      if (fault === "serverErrorAfterSend") return gErr(503, "ServiceUnavailable");
      return new HttpResponse(null, { status: 202, headers: { "request-id": `synthetic-w-${String(++seq)}` } });
    }),

    // Anything else under /me/messages or /me/mailFolders, with any other method, is a forbidden route: refused, recorded.
    http.all(`${GRAPH_V1}/me/*`, async ({ request }) => {
      const a = accountOf(request.headers.get("authorization"));
      await record(request, a, unexpected);
      return new HttpResponse(null, { status: 405 });
    }),
  ];

  const api: FakeMailWrite = {
    handlers,
    requests,
    unexpected,
    counts,
    sentLag: 0,
    idChangesOnSend: false,
    faultAfterSend: null,
    messages: (a) => [...box(a).values()],
    inFolder: (a, f) => [...box(a).values()].filter((m) => m.folder === f),
    seed(a, over) {
      const m: FakeWriteMessage = {
        folder: "inbox", subject: "Synthetic parent", from: "dana@sender.example.test", to: [{ emailAddress: { address: a.address } }], cc: [], bcc: [], bodyContent: "", bodyContentType: "text", isDraft: false, props: new Map(), headers: [], hiddenLookups: 0,
        ...over,
      };
      box(a).set(m.id, m);
      return m;
    },
    failNext(key, status, times = 1) {
      fails.push({ key, status, left: times });
    },
    reset() {
      boxes.clear();
      requests.length = 0;
      unexpected.length = 0;
      counts.created = counts.replies = counts.patched = counts.sent = 0;
      fails.length = 0;
      api.sentLag = 0;
      api.idChangesOnSend = false;
      api.faultAfterSend = null;
    },
    editBody(a, id, content) {
      const m = find(a, id);
      if (!m) throw new Error("no such fake message");
      m.bodyContent = content;
    },
  };
  return api;
}
