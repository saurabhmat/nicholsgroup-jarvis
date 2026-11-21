// T-260, T-261: provider names come from the row's connection, fixed in code; unknown providers get none; labels appear only for a viewer with a non-Google connection.
import { describe, expect, it } from "vitest";
import { coverageLine, toCoverage, type CoverageRow } from "./coverage";
import { needsSourceLabels, openInText, sourceLabel, sourceName, sourceTags } from "./source-labels";
import { staleDataLine, syncStatus } from "./sync-status";

describe("source names", () => {
  it("name the mail and calendar of each known provider", () => {
    expect([sourceName("google", "mail"), sourceName("google", "calendar"), sourceName("microsoft", "mail"), sourceName("microsoft", "calendar")]).toEqual(["Gmail", "Google Calendar", "Outlook", "Outlook"]);
    expect([openInText("google", "mail"), openInText("microsoft", "mail"), openInText("google", "calendar"), openInText("microsoft", "calendar")]).toEqual(["Open in Gmail", "Open in Outlook", "Open in Google Calendar", "Open in Outlook"]);
  });
  it("give nothing for an unknown provider, a missing one, or a name that only looks like a property of the table", () => {
    for (const p of ["quickbooks", "", null, undefined, "__proto__", "constructor", "toString"]) {
      expect(sourceName(p, "mail")).toBeNull();
      expect(openInText(p, "calendar")).toBeNull();
      expect(sourceLabel({ provider: p, account: "a@x.test" }, "mail")).toBeNull();
    }
  });
  it("labels a row with the provider and the account, or the provider alone when the account is unknown", () => {
    expect(sourceLabel({ provider: "microsoft", account: "robert@pubkgroup.example.test" }, "mail")).toBe("Outlook · robert@pubkgroup.example.test");
    expect(sourceLabel({ provider: "google", account: "" }, "calendar")).toBe("Google Calendar");
  });
});

describe("when labels are shown", () => {
  it("only when some connection is not Google's", () => {
    expect(needsSourceLabels(["google", "google"])).toBe(false);
    expect(needsSourceLabels([])).toBe(false);
    expect(needsSourceLabels(["google", null])).toBe(false);
    expect(needsSourceLabels(["google", "microsoft"])).toBe(true);
    expect(needsSourceLabels(["microsoft"])).toBe(true);
    expect(needsSourceLabels(["quickbooks"])).toBe(false); // not a mail or calendar provider
  });
  it("tags per stream keep a connection's own provider and account, and skip rows with no connection", () => {
    const items = [
      { stream: "mail" as const, connectionId: "a", provider: "google", account: "g@x.test" },
      { stream: "mail" as const, connectionId: "b", provider: "microsoft", account: "m@x.test" },
      { stream: "calendar" as const, connectionId: "b", provider: "microsoft", account: "m@x.test" },
      { stream: "mail" as const, connectionId: null, provider: null, account: "n@x.test" },
    ];
    expect(sourceTags(items, "mail")).toEqual({ a: { provider: "google", account: "g@x.test" }, b: { provider: "microsoft", account: "m@x.test" } });
    expect(Object.keys(sourceTags(items, "calendar"))).toEqual(["b"]);
  });
});

describe("the Coverage line", () => {
  const row = (stream: "mail" | "calendar", provider: string, account: string): CoverageRow => ({ stream, account, connectionId: `${provider}-${account}`, provider, status: "active", configured: true, lastSyncAt: "2026-11-20T14:55:00Z", errorKind: null });
  const now = new Date("2026-11-20T15:00:00Z");
  it("is exactly what it was for a Google-only list", () => {
    expect(coverageLine(toCoverage([row("mail", "google", "a@x.test"), row("calendar", "google", "a@x.test")], now, 120), true)).toBe("Coverage: Mail a@x.test, Calendar a@x.test up to date.");
  });
  it("names the provider of each source when both providers are present, so the same address in both stays distinct", () => {
    const line = coverageLine(toCoverage([row("mail", "google", "a@x.test"), row("mail", "microsoft", "a@x.test")], now, 120), true);
    expect(line).toBe("Coverage: Mail a@x.test (Gmail), Mail a@x.test (Outlook) up to date.");
  });
});

describe("the stale line and the sync status treat a Microsoft stream like a Google one (T-260, T-261)", () => {
  const now = new Date("2026-11-20T15:00:00Z");
  const row = (stream: "mail" | "calendar", provider: string, lastSyncAt: string | null, over: Partial<CoverageRow> = {}): CoverageRow => ({ stream, account: `${provider}@x.test`, connectionId: `c-${provider}-${stream}`, provider, status: "active", configured: true, lastSyncAt, errorKind: null, ...over });
  it("the same stale sentence for a mailbox last synced two days ago, whichever provider it is", () => {
    const stale = (provider: string) => staleDataLine(toCoverage([row("mail", provider, "2026-11-18T12:00:00Z")], now, 120), now);
    expect(stale("microsoft")).toBe(stale("google"));
    expect(stale("microsoft")).toContain("Mail was last synced");
  });
  it("one stale Microsoft mailbox beside a fresh Google one makes the mail stream stale (the oldest source decides)", () => {
    const items = toCoverage([row("mail", "google", "2026-11-20T14:55:00Z"), row("mail", "microsoft", "2026-11-18T12:00:00Z")], now, 120);
    expect(staleDataLine(items, now)).toContain("Mail was last synced 2 days ago");
    expect(syncStatus(items, now)[0]).toMatchObject({ stream: "mail", total: 2, state: "stale" });
  });
  it("a failed Microsoft sync names Microsoft with the fixed text", () => {
    const items = toCoverage([row("mail", "microsoft", "2026-11-20T14:55:00Z", { errorKind: "reconnect_required" })], now, 120);
    expect(syncStatus(items, now)[0]?.text).toBe("Mail sync failed: Microsoft access expired. Reconnect in Settings.");
  });
});
