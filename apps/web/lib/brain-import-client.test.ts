import { afterEach, describe, expect, it, vi } from "vitest";
import { callImport, droppedNote, groupByTarget, isImportRequest, tickedItems } from "./brain-import-client";
import { isInterviewRequest } from "./brain-interview-client";

const c = (id: string, target: "about_me" | "preferences" | "work" | "pa", fact = id) => ({ id, fact, evidence: null, target, targetLabel: "x", section: "s", flags: [] });

describe("checklist helpers", () => {
  it("groups by target in the fixed order and leaves out empty groups", () => {
    const g = groupByTarget([c("1", "work"), c("2", "about_me"), c("3", "work")]);
    expect(g.map((x) => [x.target, x.items.map((i) => i.id)])).toEqual([["about_me", ["2"]], ["work", ["1", "3"]]]);
  });
  it("tickedItems: only ticked, edited text wins, an emptied edit falls back to the fact", () => {
    const cs = [c("1", "about_me", "Fact one"), c("2", "work", "Fact two"), c("3", "pa", "Fact three")];
    expect(tickedItems(cs, { "1": true, "3": true }, { "1": "Edited one", "3": "   " })).toEqual([{ id: "1", text: "Edited one" }, { id: "3", text: "Fact three" }]);
    expect(tickedItems(cs, {}, {})).toEqual([]);
  });
  it("droppedNote reports counts only", () => {
    expect(droppedNote({ instructions: 0, sensitive: 0, other: 3 })).toBeNull();
    expect(droppedNote({ instructions: 2, sensitive: 1, other: 0 })).toBe("2 line(s) that read like instructions to an assistant were left out; 1 item(s) that looked like passwords or account numbers were left out.");
  });
});

describe("request detection", () => {
  it("recognises import requests and nothing vaguer or longer; setup phrases keep their meaning", () => {
    for (const t of ["import my memories", "Import my memories from ChatGPT", "bring in my claude memory", "I want to import memories"]) expect(isImportRequest(t)).toBe(true);
    for (const t of ["what needs my attention", "import my emails", `import my memories ${"x".repeat(100)}`]) expect(isImportRequest(t)).toBe(false);
    expect(isInterviewRequest("import my memories")).toBe("import");
    expect(isInterviewRequest("set up my brain")).toBe("setup");
  });
});

describe("callImport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns data on ok, the error code otherwise, session on 401 and unavailable on a network failure", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ok: true, a: 1 }));
    expect(await callImport("PKG", { action: "x" })).toEqual({ ok: true, data: { ok: true, a: 1 } });
    vi.stubGlobal("fetch", async () => Response.json({ error: "not_allowed" }, { status: 403 }));
    expect(await callImport("PKG", {})).toEqual({ ok: false, code: "not_allowed" });
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    expect(await callImport("PKG", {})).toEqual({ ok: false, code: "session" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("net");
    });
    expect(await callImport("PKG", {})).toEqual({ ok: false, code: "unavailable" });
  });
  it("posts to the lane's import route", async () => {
    const f = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", f);
    await callImport("PKG", { action: "discard" });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("/api/lanes/PKG/brain/import");
  });
});
