import { describe, expect, it } from "vitest";
import { AWAITING, checkContent, extractJson, grounded, maskContent, maskText, type BriefRef } from "./compose";

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
