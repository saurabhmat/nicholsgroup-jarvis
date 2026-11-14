import { describe, expect, it } from "vitest";
import { ageShort, attentionChips, senderLabel, senderParts } from "./sender";
import { domainOf } from "./calendar";

describe("domainOf and senderLabel", () => {
  it("domainOf is the part after the LAST @, lower-cased", () => {
    expect(domainOf("a@B.test")).toBe("b.test");
    expect(domainOf("\"a@paypal.com\"@evil.test")).toBe("evil.test");
    expect(domainOf("nope")).toBe("");
  });
  it("senderLabel is name · domain of the address, never a name alone when there is an address", () => {
    expect(senderLabel("Dana Whitfield", "dana@www.acme.test")).toBe("Dana Whitfield · acme.test");
    expect(senderLabel("CEO (paypal.com)", "x@evil.test")).toBe("CEO (paypal.com) · evil.test");
    expect(senderLabel(null, "dana.w@acme.test")).toBe("dana.w@acme.test"); // T-243: no name made from the address: the full address
    expect(senderLabel("dana.w@acme.test", "dana.w@acme.test")).toBe("dana.w@acme.test");
    expect(senderLabel("Dana", null)).toBe("Dana");
  });
});

describe("senderParts", () => {
  it("name, domain without www., two initials", () => {
    expect(senderParts("Dana Whitfield", "Dana@www.acme.test")).toMatchObject({ name: "Dana Whitfield", company: "acme.test", initials: "DW" });
    expect(senderParts("Dana Whitfield", "dana@www.acme.test").company).toBe("acme.test");
  });
  it("the company slot is ALWAYS the address domain, never parsed from the display name (rule 9)", () => {
    expect(senderParts("Dana Whitfield (Acme Corp)", "dana@acme.test")).toMatchObject({ name: "Dana Whitfield (Acme Corp)", company: "acme.test" });
    expect(senderParts("CEO (nicholsgroup.com)", "x@evil.test").company).toBe("evil.test");
    expect(senderParts("Billing - paypal.com", "x@evil.test").company).toBe("evil.test");
    expect(senderParts("Dana Whitfield | Acme Corp", null).company).toBeNull();
    expect(senderParts("Jean-Luc Picard", "jl@starfleet.test")).toMatchObject({ name: "Jean-Luc Picard", company: "starfleet.test" });
  });
  it("the domain is taken from the LAST @", () => {
    expect(senderParts("x", '"a@paypal.com"@evil.test').company).toBe("evil.test");
  });
  it("T-243: never a name built from an address: a real display name as written, else the FULL address, else Unknown sender", () => {
    expect(senderParts(null, "dana.whitfield@acme.test")).toMatchObject({ name: "dana.whitfield@acme.test", nameIsAddress: true, initials: "D", company: "acme.test" });
    expect(senderParts("", "rnichols@acme.test")).toMatchObject({ name: "rnichols@acme.test", nameIsAddress: true });
    expect(senderParts("  ", "noreply@acme.test")).toMatchObject({ name: "noreply@acme.test", nameIsAddress: true });
    expect(senderParts("dana@acme.test", "dana@acme.test")).toMatchObject({ name: "dana@acme.test", nameIsAddress: true });
    // A display name that is another address is not trusted as a name: the real From address is shown.
    expect(senderParts("ceo@bank.test", "x@evil.test")).toMatchObject({ name: "x@evil.test", nameIsAddress: true, company: "evil.test" });
    expect(senderParts("Dana Whitfield", "dana@acme.test")).toMatchObject({ name: "Dana Whitfield", nameIsAddress: false });
    expect(senderParts(null, null)).toMatchObject({ name: "Unknown sender", nameIsAddress: false, company: null });
    for (const [n, a] of [[null, "sam_o-neil+tag@x.test"], ["", "info@x.test"]] as const) expect(senderParts(n, a).name).not.toMatch(/^[A-Z]/);
  });
  it("one initial for one word; unicode letters; no letters", () => {
    expect(senderParts("Madonna", "m@x.test").initials).toBe("M");
    expect(senderParts("Élodie Dupont", "e@x.test").initials).toBe("ÉD");
    expect(senderParts("1234", null).initials).toBe("?");
  });
  it("the palette slot is deterministic and in range", () => {
    const a = senderParts("A", "a@x.test", 4);
    expect(senderParts("Other name", "A@x.test", 4).slot).toBe(a.slot);
    for (const addr of ["a@x.test", "b@y.test", "c@z.test", "d@w.test"]) expect(senderParts(null, addr, 4).slot).toBeLessThan(4);
  });
});

describe("attentionChips (T-240)", () => {
  const labels = (item: Parameters<typeof attentionChips>[0], max?: number) => attentionChips(item, max).map((c) => c.label);
  it("'Waiting on you' only when the owner is in the To and no reply followed", () => {
    expect(labels({ kind: "waiting", unread: false, waitingOnYou: true })).toEqual(["Waiting on you"]);
    expect(labels({ kind: "waiting", unread: false, waitingOnYou: false })).toEqual([]); // Cc, list address or unknown: no chip
    expect(labels({ kind: "waiting", unread: false })).toEqual([]);
    expect(labels({ kind: "unread", unread: true, waitingOnYou: true })).toEqual(["Waiting on you", "Unread"]);
  });
  it("otherwise the reason: VIP, Money, Deadline", () => {
    expect(labels({ kind: "priority", unread: true })).toEqual(["VIP", "Unread"]);
    expect(labels({ kind: "waiting", unread: false, money: true })).toEqual(["Money"]);
    expect(labels({ kind: "unread", unread: true, deadline: true })).toEqual(["Deadline", "Unread"]);
    expect(labels({ kind: "waiting", unread: false, deadline: true, money: true })).toEqual(["Money", "Deadline"]);
  });
  it("at most two chips, in order VIP, Waiting on you, Money, Deadline, Unread", () => {
    expect(labels({ kind: "priority", unread: true, vip: true, waitingOnYou: true, money: true, deadline: true })).toEqual(["VIP", "Waiting on you"]);
    expect(labels({ kind: "unread", unread: true, waitingOnYou: true, money: true })).toEqual(["Waiting on you", "Money"]);
    expect(labels({ kind: "unread", unread: true, waitingOnYou: true, money: true, deadline: true }, 4)).toEqual(["Waiting on you", "Money", "Deadline", "Unread"]);
  });
  it("security and repeated failures", () => {
    expect(labels({ kind: "security", unread: true })).toEqual(["Unread", "Security alert"]);
    expect(labels({ kind: "repeated_failures", unread: false })).toEqual(["Repeated failures"]);
  });
});

describe("ageShort", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  it("now, minutes, hours, days", () => {
    expect(ageShort("2026-11-12T11:59:40Z", now)).toBe("now");
    expect(ageShort("2026-11-12T11:48:00Z", now)).toBe("12m");
    expect(ageShort("2026-11-12T10:00:00Z", now)).toBe("2h");
    expect(ageShort("2026-11-09T12:00:00Z", now)).toBe("3d");
    expect(ageShort("2026-11-13T12:00:00Z", now)).toBe("now"); // a future clock skew never shows a negative age
  });
});
