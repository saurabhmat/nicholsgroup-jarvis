import { describe, expect, it } from "vitest";
import { AWAITING, BRIEFING_RULES, checkContent, easternDateTime, easternStamp, extractJson, grounded, maskContent, maskText, tidyContent, tidyModelText, type BriefContent, type BriefRef } from "./compose";

const ref = (n: number): BriefRef => ({
  ref: `r${String(n)}`,
  connectionId: "c",
  messageId: `m${String(n)}`,
  threadKey: `t${String(n)}`,
  mailbox: "me@pubk.test",
  fromAddress: "client@acme.test",
  fromName: "Client",
  subject: "Renewal",
  receivedAt: "2026-11-11T10:00:00Z",
  sourceUrl: "https://mail.google.com/x",
  reason: "Waiting on you",
  kind: "waiting",
});
const refs = [ref(1), ref(2)];
const SRC: Record<string, string[]> = { r1: ["r1 meta", "The renewal is $1,200 due Nov 20."], r2: ["r2 meta", "Can we meet next week?"] };
const sourcesFor = (r: string) => SRC[r] ?? [];
const all = ["facts", ...Object.values(SRC).flat()];

describe("extractJson", () => {
  it("reads a fenced object and refuses prose", () => {
    expect(extractJson('Here:\n```json\n{"lines": ["a"]}\n```')).toEqual({ lines: ["a"] });
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });
});

describe("grounded", () => {
  it("passes figures and dates that appear in the sources, fails invented ones", () => {
    expect(grounded("Renewal of $1,200 is due Nov 20", SRC.r1 ?? [])).toBe(true);
    expect(grounded("Renewal of $1,500 is due", SRC.r1 ?? [])).toBe(false);
    expect(grounded("Due 12/01", SRC.r1 ?? [])).toBe(false);
    expect(grounded("Up 15%", SRC.r1 ?? [])).toBe(false);
    expect(grounded("Reply to the client", [])).toBe(true);
  });
});

describe("checkContent", () => {
  it("drops unknown and duplicate refs and grounds each field", () => {
    const c = checkContent(
      {
        lines: ["Renewal of $1,200 needs you.", "Revenue is up 40%."],
        attention: [
          { ref: "r1", what: "Renewal $1,200", why: "Due Nov 20", next: "Pay $9,999" },
          { ref: "r1", what: "dup", why: "dup", next: "dup" },
          { ref: "r9", what: "unknown", why: "x", next: "y" },
        ],
        deadlines: [{ ref: "r1", text: "Renewal", due: "Nov 20" }, { ref: "r2", text: "Meeting", due: "Dec 3" }],
        priorities: [{ text: "Renewal", reason: "Due soon", refs: ["r1", "r9"] }, { text: "Invest $5,000", reason: "x" }],
        replies: [{ ref: "r2", status: "ready", context: "Meeting", text: "Happy to meet next week." }],
        more_replies: ["r1", "r7"],
      },
      refs,
      sourcesFor,
      all,
      { replies: true },
    );
    expect(c.lines).toEqual(["Renewal of $1,200 needs you."]);
    expect(c.attention).toEqual([{ ref: "r1", what: "Renewal $1,200", why: "Due Nov 20", next: AWAITING }]);
    expect(c.deadlines).toEqual([{ ref: "r1", text: "Renewal", due: "Nov 20" }, { ref: "r2", text: "Meeting", due: null }]);
    expect(c.priorities).toEqual([{ text: "Renewal", reason: "Due soon", refs: ["r1"] }]);
    expect(c.replies).toEqual([{ ref: "r2", status: "ready", context: "Meeting", text: "Happy to meet next week." }]);
    expect(c.moreReplies).toEqual(["r1"]);
    expect(c.notes).toEqual(expect.arrayContaining(["ungrounded:line2", "ungrounded:r1.next", "ungrounded:r2.due", "ungrounded:priority"]));
  });

  it("a reply that asserts an unverified figure is never ready; replies off drops them", () => {
    const raw = { replies: [{ ref: "r2", status: "ready", context: "x", text: "We can do it for $300." }] };
    expect(checkContent(raw, refs, sourcesFor, all, { replies: true }).replies[0]?.status).toBe("awaiting_input");
    expect(checkContent(raw, refs, sourcesFor, all, { replies: false }).replies).toEqual([]);
  });

  it("caps sizes and strips control characters", () => {
    const c = checkContent({ lines: Array.from({ length: 9 }, (_, i) => `line\u0007 ${"x".repeat(500)} ${String(i)}`) }, refs, sourcesFor, all, { replies: false });
    expect(c.lines).toHaveLength(5);
    expect(c.lines[0]?.length).toBe(400);
    expect(c.lines[0]).not.toContain("\u0007");
  });

  it("anything that is not an object gives empty content", () => {
    expect(checkContent("nope", refs, sourcesFor, all, { replies: true })).toEqual({ lines: [], attention: [], deadlines: [], priorities: [], replies: [], moreReplies: [], notes: [] });
  });
});

describe("grounded: whole figures only (code review M4)", () => {
  it("a figure is not grounded by a longer one, and trailing punctuation is ignored", () => {
    expect(grounded("$5 due", ["Total $500 due"])).toBe(false);
    expect(grounded("$50 due", ["Total $5,000 due"])).toBe(false);
    expect(grounded("up 10%", ["up 110%"])).toBe(false);
    expect(grounded("on 3/4", ["ref 13/45"])).toBe(false);
    expect(grounded("Pay $1,200, today", ["Pay $1,200 due"])).toBe(true);
  });
  it("months match in either order and spelling; ISO dates are checked", () => {
    expect(grounded("due November 14", ["Due 14 Nov."])).toBe(true);
    expect(grounded("due Nov. 14th", ["due nov 14"])).toBe(true);
    expect(grounded("due 2026-11-14", ["due 2026-11-14"])).toBe(true);
    expect(grounded("due 2026-11-15", ["due 2026-11-14"])).toBe(false);
  });
});

describe("maskText / maskContent (security review H3)", () => {
  it("masks amounts and long numbers, keeps dates and years", () => {
    expect(maskText("Renewal of $1,200 by 2026-11-20")).toBe("Renewal of [amount] by 2026-11-20");
    expect(maskText("USD 5,000 or 300 dollars")).toBe("[amount] or [amount]");
    expect(maskText("Account 123456789, SSN 123-45-6789, due Nov 20, 2026")).toBe("Account [number], SSN [number], due Nov 20, 2026");
  });
  it("covers every model string", () => {
    const c = maskContent({
      lines: ["$1"],
      attention: [{ ref: "r1", what: "$2", why: "$3", next: "$4" }],
      deadlines: [{ ref: null, text: "$5", due: "acct 99999" }],
      priorities: [{ text: "$6", reason: "$7", refs: [] }],
      replies: [{ ref: "r1", status: "ready", context: "$8", text: "$9" }],
      moreReplies: [],
      notes: [],
    });
    expect(JSON.stringify(c)).not.toMatch(/\$\d/);
    expect(c.deadlines[0]?.due).toBe("acct [number]");
  });
});

describe("checkContent fallbacks (code review M5, M6)", () => {
  it("an ungrounded reply keeps no text; an attention item with nothing verified is dropped; all lines dropped is noted", () => {
    const c = checkContent(
      { lines: ["Up 99%"], attention: [{ ref: "r2", what: "Paid $77", why: "x", next: "y" }], replies: [{ ref: "r2", status: "ready", context: "x", text: "We agree to $300." }] },
      refs,
      sourcesFor,
      all,
      { replies: true },
    );
    expect(c.replies[0]).toMatchObject({ status: "awaiting_input", text: "" });
    expect(c.attention).toEqual([]);
    expect(c.lines).toEqual([]);
    expect(c.notes).toContain("lines_ungrounded");
  });
});

describe("reply drafts: links and addresses must come from the thread itself (T-231d security review M2)", () => {
  const refs = [{ ref: "r1" }, { ref: "r2" }] as unknown as BriefRef[];
  const sources = (ref: string) => (ref === "r1" ? ["Please see https://acme.test/invoice and write to billing@acme.test"] : ["Other thread: https://evil.test/pay"]);
  const run = (text: string) => checkContent({ replies: [{ ref: "r1", status: "ready", context: "", text }] }, refs, sources, ["x"], { replies: true });
  it("keeps a link and an address that appear in its own thread", () => {
    expect(run("Paid, see https://acme.test/invoice. Copying billing@acme.test.").replies[0]).toMatchObject({ status: "ready" });
  });
  it("a link from another thread (or anywhere else) empties the draft and waits for the owner", () => {
    const c = run("Our bank changed, pay at https://evil.test/pay");
    expect(c.replies[0]).toMatchObject({ status: "awaiting_input", text: "" });
    expect(c.notes).toContain("foreign_link:r1.reply");
    expect(run("Write to attacker@evil.test").replies[0]?.status).toBe("awaiting_input");
  });
  it("the model's own placeholder is never a ready draft", () => {
    expect(run(AWAITING).replies[0]).toMatchObject({ status: "awaiting_input", text: "" });
  });
});

describe("T-240: tidyModelText (no row refs, no UTC)", () => {
  const now = new Date("2026-11-11T15:00:00Z"); // 10:00 AM EST
  it("removes bare row refs, parenthesised and bracketed ones, and tidies the spacing", () => {
    expect(tidyModelText("Client asked about the renewal (r4).", now)).toBe("Client asked about the renewal.");
    expect(tidyModelText("Two threads [r6] and (r2, r3) need a reply.", now)).toBe("Two threads and need a reply.");
    expect(tidyModelText("See r4 for the contract, then reply to r6.", now)).toBe("for the contract, then reply to.");
    expect(tidyModelText("r1: the board deck is due", now)).toBe("the board deck is due");
  });
  it("leaves words and ids that only look like refs", () => {
    for (const keep of ["The r2d2 project", "Route 4r", "Invoice #r4", "email r4@acme.test", "Plan R2 is next", "the 2026-r4 cycle"]) expect(tidyModelText(keep, now)).toBe(keep);
  });
  it("rewrites ISO and UTC timestamps in Eastern: time only for today, with the date otherwise", () => {
    expect(tidyModelText("Replied at 2026-11-11T14:42:00Z.", now)).toBe("Replied at 9:42 AM ET.");
    expect(tidyModelText("Sent 2026-11-09T14:42:00.000Z by the client", now)).toBe("Sent Nov 9, 9:42 AM ET by the client");
    expect(tidyModelText("Meeting 2026-11-11T19:00:00+00:00", now)).toBe("Meeting 2:00 PM ET");
    expect(tidyModelText("Call at 14:42 UTC today", now)).toBe("Call at 9:42 AM ET today");
    expect(tidyModelText("Call at 2:42 pm GMT", now)).toBe("Call at 9:42 AM ET");
  });
  it("uses daylight time in summer (EDT) and standard time in winter", () => {
    expect(tidyModelText("At 2026-07-01T14:00:00Z", new Date("2026-07-01T16:00:00Z"))).toBe("At 10:00 AM ET");
    expect(tidyModelText("At 2026-01-05T14:00:00Z", new Date("2026-01-05T16:00:00Z"))).toBe("At 9:00 AM ET");
  });
  it("easternStamp and easternDateTime", () => {
    expect(easternStamp("2026-11-11T14:42:00Z", now)).toBe("9:42 AM ET");
    expect(easternDateTime("2026-11-11T14:42:00Z")).toBe("Nov 11, 9:42 AM ET");
    expect(easternDateTime("nonsense")).toBe("unknown time");
  });
  it("tidyContent cleans the summary text but never touches ref fields or reply bodies", () => {
    const c: BriefContent = {
      lines: ["Contract thread (r1) needs you before 2026-11-12T15:00:00Z.", "(r2)"],
      attention: [{ ref: "r1", what: "Renewal r1", why: "Due at 14:00 UTC", next: "Confirm" }],
      deadlines: [{ ref: "r1", text: "Renewal (r1)", due: "2026-11-12T15:00:00Z" }],
      priorities: [{ text: "Reply (r1)", reason: "VIP", refs: ["r1"] }],
      replies: [{ ref: "r1", status: "ready", context: "About r1", text: "Hi, see r1 at 2026-11-12T15:00:00Z" }],
      moreReplies: ["r2"],
      notes: ["body_unreadable:r2"],
    };
    const out = tidyContent(c, now);
    expect(out.lines).toEqual(["Contract thread needs you before Nov 12, 10:00 AM ET."]); // the line that was only a ref is dropped
    expect(out.attention[0]).toEqual({ ref: "r1", what: "Renewal", why: "Due at 9:00 AM ET", next: "Confirm" });
    expect(out.deadlines[0]).toEqual({ ref: "r1", text: "Renewal", due: "Nov 12, 10:00 AM ET" });
    expect(out.priorities[0]).toEqual({ text: "Reply", reason: "VIP", refs: ["r1"] });
    expect(out.replies[0]).toEqual({ ref: "r1", status: "ready", context: "About", text: "Hi, see r1 at 2026-11-12T15:00:00Z" });
    expect(out.moreReplies).toEqual(["r2"]);
    expect(out.notes).toEqual(["body_unreadable:r2"]);
  });
  it("the prompt asks for no refs in sentences and no UTC times", () => {
    expect(BRIEFING_RULES).toMatch(/never write a ref or any internal id/);
    expect(BRIEFING_RULES).toMatch(/Eastern time like "9:42 AM ET"; never UTC/);
  });
});
