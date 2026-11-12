import { describe, expect, it } from "vitest";
import { ageShort, attentionChips, senderParts } from "./sender";

describe("senderParts", () => {
  it("name, domain without www., two initials", () => {
    expect(senderParts("Dana Whitfield", "Dana@www.acme.test")).toMatchObject({ name: "Dana Whitfield", company: "acme.test", initials: "DW" });
    expect(senderParts("Dana Whitfield", "dana@www.acme.test").company).toBe("acme.test");
  });
  it("the organisation part of the display name wins", () => {
    expect(senderParts("Dana Whitfield (Acme Corp)", "dana@acme.test")).toMatchObject({ name: "Dana Whitfield", company: "Acme Corp" });
    expect(senderParts("Dana Whitfield | Acme Corp", "dana@acme.test")).toMatchObject({ name: "Dana Whitfield", company: "Acme Corp" });
    expect(senderParts("Dana Whitfield - Acme Corp", null)).toMatchObject({ name: "Dana Whitfield", company: "Acme Corp" });
    expect(senderParts("Jean-Luc Picard", "jl@starfleet.test")).toMatchObject({ name: "Jean-Luc Picard", company: "starfleet.test" }); // a hyphen inside a name is not a separator
  });
  it("no name: the local part, capitalised (a role mailbox unchanged); no address: Unknown sender", () => {
    expect(senderParts(null, "dana.whitfield@acme.test")).toMatchObject({ name: "Dana Whitfield", initials: "DW" });
    expect(senderParts(null, "noreply@acme.test")).toMatchObject({ name: "noreply", initials: "N" });
    expect(senderParts("dana@acme.test", "dana@acme.test").name).toBe("Dana");
    expect(senderParts(null, null)).toMatchObject({ name: "Unknown sender", company: null });
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

describe("attentionChips", () => {
  it("priority order, at most two", () => {
    expect(attentionChips("priority", true).map((c) => c.label)).toEqual(["Priority sender", "Unread"]);
    expect(attentionChips("waiting", true).map((c) => c.label)).toEqual(["Waiting on you", "Unread"]);
    expect(attentionChips("security", true).map((c) => c.label)).toEqual(["Unread", "Security alert"]);
    expect(attentionChips("unread", true).map((c) => c.label)).toEqual(["Unread"]);
    expect(attentionChips("waiting", false)).toHaveLength(1);
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
