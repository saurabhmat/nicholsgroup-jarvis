// T-260: Home for a person whose only mail feed is Microsoft: the unread-important count is shown (it used to need a Google feed), and a Microsoft feed is named "Microsoft".
import { describe, expect, it } from "vitest";
import { composeBriefing, loadHome, toAttention } from "./home";

type Result = { data: unknown; error: unknown };
const ok = (data: unknown): Result => ({ data, error: null });
const fakeClient = (conns: unknown[], mail: unknown) => ({
  schema: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve(ok(conns)) }) }) }),
    rpc: (fn: string) => Promise.resolve({ home_meetings: ok([]), home_mail_attention: ok(mail), home_calendar_status: ok("connected") }[fn]),
  }),
});
const now = new Date("2026-11-20T15:00:00Z");
const counts = [{ unread_important: 3, unread_priority: 0, priority_configured: false }];

describe("Home's unread-important count", () => {
  it("is shown for a person with only Microsoft feeds, and with Google and Microsoft feeds", async () => {
    expect((await loadHome(fakeClient([{ provider: "microsoft", status: "active" }], counts) as never, "PKG", now)).unreadImportant).toBe(3);
    expect((await loadHome(fakeClient([{ provider: "google", status: "active" }, { provider: "microsoft", status: "active" }], counts) as never, "PKG", now)).unreadImportant).toBe(3);
  });
  it("is still hidden when the only feeds are not mail feeds (a '0' about a mailbox that is not connected stays wrong), and when SQL returned no counts", async () => {
    expect((await loadHome(fakeClient([{ provider: "quickbooks", status: "active" }], counts) as never, "PKG", now)).unreadImportant).toBeNull();
    expect((await loadHome(fakeClient([{ provider: "microsoft", status: "active" }], []) as never, "PKG", now)).unreadImportant).toBeNull();
  });
  it("the attention line and the fallback text say 'Microsoft', not the raw provider id", () => {
    const items = toAttention({ connections: [{ id: "c1", provider: "microsoft", status: "reconnect_required" }], meetings: [], mail: { unread_important: 2, unread_priority: 0, priority_configured: false }, now });
    expect(items.map((i) => i.label)).toEqual(["Microsoft needs reconnecting", "2 unread important emails in the last 24 hours"]);
    expect(composeBriefing({ calendar: "no_access", meetings: [], upcoming: [], feeds: [{ provider: "microsoft", status: "active" }], unreadImportant: 2 }, now)).toEqual(["2 unread important emails in the last 24 hours.", "Microsoft is connected."]);
  });
});
