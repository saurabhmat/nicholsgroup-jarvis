import { describe, expect, it } from "vitest";
import { deriveMailFlags } from "./mail-flags";

const h = (o: Record<string, string>) => new Map(Object.entries(o));
const none = { is_bulk: false, is_calendar: false, is_auto: false };

describe("deriveMailFlags", () => {
  it("a person's mail has no flags, even from the org's own domain", () => {
    expect(deriveMailFlags(h({ from: "Robert <robert@pubk.test>", "content-type": 'multipart/alternative; boundary="b"' }))).toEqual(none);
  });
  it("bulk: List-Unsubscribe, List-Id, Precedence bulk/list/junk", () => {
    expect(deriveMailFlags(h({ "list-unsubscribe": "<mailto:u@pubk.test>" })).is_bulk).toBe(true);
    expect(deriveMailFlags(h({ "list-id": "<weekly.pubk.test>" })).is_bulk).toBe(true);
    for (const p of ["bulk", "Bulk", "list", "junk"]) expect(deriveMailFlags(h({ precedence: p })).is_bulk).toBe(true);
    expect(deriveMailFlags(h({ precedence: "first-class" })).is_bulk).toBe(false);
  });
  it("auto: Auto-Submitted (not 'no'), X-Autoreply, Precedence auto_reply", () => {
    expect(deriveMailFlags(h({ "auto-submitted": "auto-replied" })).is_auto).toBe(true);
    expect(deriveMailFlags(h({ "auto-submitted": "auto-generated" })).is_auto).toBe(true);
    expect(deriveMailFlags(h({ "auto-submitted": "no" })).is_auto).toBe(false);
    expect(deriveMailFlags(h({ "x-autoreply": "yes" })).is_auto).toBe(true);
    expect(deriveMailFlags(h({ precedence: "auto_reply" })).is_auto).toBe(true);
  });
  it("calendar: text/calendar content type or part, Exchange content class, Google Calendar sender", () => {
    expect(deriveMailFlags(h({ "content-type": 'text/calendar; method=REQUEST; charset="UTF-8"' })).is_calendar).toBe(true);
    expect(deriveMailFlags(h({}), { mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/calendar" }] }] }).is_calendar).toBe(true);
    expect(deriveMailFlags(h({ "content-class": "urn:content-classes:calendarmessage" })).is_calendar).toBe(true);
    expect(deriveMailFlags(h({ sender: "Google Calendar <calendar-notification@google.com>" })).is_calendar).toBe(true);
    expect(deriveMailFlags(h({ sender: "Robert <robert@pubk.test>" })).is_calendar).toBe(false);
    expect(deriveMailFlags(h({}), { mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain" }] }).is_calendar).toBe(false);
  });
  it("stops at a sane depth", () => {
    let p: { mimeType: string; parts?: unknown[] } = { mimeType: "text/calendar" };
    for (let i = 0; i < 50; i++) p = { mimeType: "multipart/mixed", parts: [p] };
    expect(deriveMailFlags(h({}), p as never).is_calendar).toBe(false);
  });
});
