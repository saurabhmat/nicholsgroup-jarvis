import { describe, expect, it } from "vitest";
import { deriveMailFlags } from "./mail-flags";

const h = (o: Record<string, string>) => new Map(Object.entries(o));
const none = { is_bulk: false, is_calendar: false, is_auto: false, is_generated: false, is_auth_pass: false };

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
  it("auto: true auto-replies only (auto-replied, X-Autoreply, X-Autorespond, Precedence auto_reply)", () => {
    expect(deriveMailFlags(h({ "auto-submitted": "auto-replied" }))).toMatchObject({ is_auto: true, is_generated: false });
    expect(deriveMailFlags(h({ "auto-submitted": "no" }))).toMatchObject({ is_auto: false, is_generated: false });
    expect(deriveMailFlags(h({ "x-autoreply": "yes" })).is_auto).toBe(true);
    expect(deriveMailFlags(h({ "x-autorespond": "yes" })).is_auto).toBe(true);
    expect(deriveMailFlags(h({ precedence: "auto_reply" })).is_auto).toBe(true);
  });
  it("generated: Auto-Submitted with any other value (not no, not auto-replied) is a separate soft flag", () => {
    expect(deriveMailFlags(h({ "auto-submitted": "auto-generated" }))).toMatchObject({ is_auto: false, is_generated: true });
    expect(deriveMailFlags(h({ "auto-submitted": "auto-notified" }))).toMatchObject({ is_auto: false, is_generated: true });
  });
  it("auth pass: only the first Authentication-Results from mx.google.com; dmarc=pass, or dkim=pass aligned with the From domain", () => {
    const pass = (ar: string[], from = "boss@pubk.test") => deriveMailFlags(h({}), undefined, { fromAddress: from, authResults: ar }).is_auth_pass;
    expect(pass(["mx.google.com; dkim=pass header.i=@pubk.test header.s=s1; spf=pass; dmarc=pass (p=NONE) header.from=pubk.test"])).toBe(true);
    expect(pass(["mx.google.com; dkim=fail header.d=pubk.test; dmarc=pass header.from=pubk.test"])).toBe(true);
    expect(pass(["mx.google.com; dkim=pass header.d=mail.pubk.test; dmarc=fail"])).toBe(true);
    expect(pass(["mx.google.com; dkim=pass header.i=ops@pubk.test; dmarc=fail"])).toBe(true);
    expect(pass(["mx.google.com; dkim=pass header.d=evil.test header.i=@evil.test; dmarc=fail"])).toBe(false); // domain mismatch
    expect(pass(["mx.google.com; dkim=pass header.d=notpubk.test; dmarc=fail"])).toBe(false);
    expect(pass(["mx.google.com; dkim=fail header.d=pubk.test; spf=pass; dmarc=fail"])).toBe(false);
    expect(pass(["mx.evil.test; dmarc=pass header.from=pubk.test"])).toBe(false); // non-Google authserv-id is ignored
    // Only the TOPMOST header counts, and only when it is Google's (security re-check M1): a lower one may be the sender's.
    expect(pass(["mx.evil.test; spf=fail", "mx.google.com; dmarc=pass header.from=pubk.test"])).toBe(false);
    expect(pass(["mx.google.com; dmarc=fail header.from=pubk.test", "mx.google.com; dmarc=pass header.from=pubk.test"])).toBe(false);
    expect(pass(["mx.google.com.evil; dmarc=pass header.from=pubk.test"])).toBe(false);
    expect(pass([])).toBe(false);
    expect(pass([`mx.google.com; dmarc=pass header.from=pubk.test; ${"x".repeat(5000)}`])).toBe(false); // oversized
  });
  it("auth pass cannot be forged through comments, quoted strings or another domain's dmarc (security re-check H1)", () => {
    const pass = (ar: string[], from = "ceo@priority.test") => deriveMailFlags(h({}), undefined, { fromAddress: from, authResults: ar }).is_auth_pass;
    // A ";dmarc=pass" smuggled in the envelope sender, echoed in the SPF comment and smtp.mailfrom.
    expect(pass(['mx.google.com; dkim=fail header.d=evil.test; spf=pass (google.com: domain of "a;dmarc=pass"@evil.test designates 1.2.3.4) smtp.mailfrom="a;dmarc=pass"@evil.test; dmarc=fail header.from=priority.test'])).toBe(false);
    expect(pass(['mx.google.com; spf=pass smtp.mailfrom="x;dkim=pass header.d=priority.test x"@evil.test; dmarc=fail header.from=priority.test'])).toBe(false);
    // dmarc=pass for ANOTHER domain is not a pass for this From.
    expect(pass(["mx.google.com; dmarc=pass header.from=evil.test"])).toBe(false);
    expect(pass(["mx.google.com; dmarc=pass"])).toBe(false); // no header.from: no pass
    // header.d inside a comment is not read.
    expect(pass(["mx.google.com; dkim=pass (header.d=priority.test) header.i=@evil.test"])).toBe(false);
    // Unbalanced comment or quote: fail closed.
    expect(pass(["mx.google.com; dmarc=pass header.from=priority.test (oops"])).toBe(false);
    expect(pass(['mx.google.com; dmarc=pass header.from=priority.test "oops'])).toBe(false);
    // Google's real shape still passes (comments removed, header.from exact).
    expect(pass(["mx.google.com; dkim=pass header.i=@priority.test header.s=s1 header.b=AbC; spf=pass (google.com: domain of x@priority.test designates 1.2.3.4 as permitted sender) smtp.mailfrom=x@priority.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=priority.test"])).toBe(true);
    expect(pass(["mx.google.com 1; dmarc=pass (p=NONE) header.from=priority.test"])).toBe(true); // with a version number
    expect(deriveMailFlags(h({}), undefined, { fromAddress: null, authResults: ["mx.google.com; dmarc=pass"] }).is_auth_pass).toBe(false);
    expect(deriveMailFlags(h({ "authentication-results": "mx.google.com; dmarc=pass" })).is_auth_pass).toBe(false); // needs the context
  });
  it("calendar: text/calendar content type or part, Exchange content class, Google Calendar sender", () => {
    expect(deriveMailFlags(h({ "content-type": 'text/calendar; method=REQUEST; charset="UTF-8"' })).is_calendar).toBe(true);
    expect(deriveMailFlags(h({}), { mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/calendar" }] }] }).is_calendar).toBe(true);
    expect(deriveMailFlags(h({ "content-class": "urn:content-classes:calendarmessage" })).is_calendar).toBe(true);
    expect(deriveMailFlags(h({ sender: "Google Calendar <calendar-notification@google.com>" })).is_calendar).toBe(true);
    expect(deriveMailFlags(h({ sender: "Robert <robert@pubk.test>" })).is_calendar).toBe(false);
    // the Sender regex is anchored: a look-alike address is not Google Calendar
    expect(deriveMailFlags(h({ sender: "fake-calendar-notification@google.com" })).is_calendar).toBe(false);
    expect(deriveMailFlags(h({ sender: "calendar-notification@google.com.evil.test" })).is_calendar).toBe(false);
    expect(deriveMailFlags(h({ sender: "calendar-notification@google.com" })).is_calendar).toBe(true);
    expect(deriveMailFlags(h({}), { mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain" }] }).is_calendar).toBe(false);
  });
  it("a malformed nested parts value does not throw", () => {
    for (const bad of ["x", 5, null, { a: 1 }, [null, 7, "y"]]) {
      expect(deriveMailFlags(h({}), { mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: bad }] } as never).is_calendar).toBe(false);
    }
    expect(deriveMailFlags(h({}), { mimeType: "multipart/mixed", parts: "nope" } as never).is_calendar).toBe(false);
  });
  it("stops at a sane depth", () => {
    let p: { mimeType: string; parts?: unknown[] } = { mimeType: "text/calendar" };
    for (let i = 0; i < 50; i++) p = { mimeType: "multipart/mixed", parts: [p] };
    expect(deriveMailFlags(h({}), p as never).is_calendar).toBe(false);
  });
});
