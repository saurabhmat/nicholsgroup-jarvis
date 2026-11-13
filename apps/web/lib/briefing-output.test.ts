// T-235 part 1: the structured-output contract of the briefing: schema from Zod, defensive parsing, validation issues as codes.
import { describe, expect, it } from "vitest";
import { buildParams } from "@nichols/ai";
import { BRIEFING_OUTPUT_SCHEMA, BriefingOutputSchema, correctionMessage, parseBriefingOutput } from "./briefing-output";

const GOOD = { lines: ["One thing needs you."], attention: [{ ref: "r1", what: "w", why: "y", next: "n" }], deadlines: [{ ref: null, text: "t", due: null }], priorities: [{ text: "p", reason: "r", refs: ["r1"] }], replies: [{ ref: "r1", status: "ready", context: "c", text: "Thanks." }], more_replies: [] };

describe("briefing output", () => {
  it("the JSON schema is generated from the Zod schema: closed objects, all six fields required", () => {
    const s = BRIEFING_OUTPUT_SCHEMA.schema as { type: string; required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(BRIEFING_OUTPUT_SCHEMA.name).toBe("briefing");
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(Object.keys(BriefingOutputSchema.shape).sort());
    expect(Object.keys(s.properties).sort()).toEqual(["attention", "deadlines", "lines", "more_replies", "priorities", "replies"]);
  });
  it("the schema sent to the API is safe: no $schema, no type arrays, every object closed with required", () => {
    const sent = buildParams({ laneId: "PKG", tier: "analysis", system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 10, outputSchema: BRIEFING_OUTPUT_SCHEMA }, "m").output_config?.format;
    expect(BRIEFING_OUTPUT_SCHEMA.schema).not.toHaveProperty("$schema");
    for (const schema of [(sent as { schema: Record<string, unknown> }).schema]) {
      expect(schema).not.toHaveProperty("$schema");
      const objects: Record<string, unknown>[] = [];
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n === null || typeof n !== "object") return;
        const o = n as Record<string, unknown>;
        expect(Array.isArray(o.type)).toBe(false);
        if (o.type === "object") objects.push(o);
        Object.values(o).forEach(walk);
      };
      walk(schema);
      expect(objects.length).toBeGreaterThan(4);
      for (const o of objects) {
        expect(o.additionalProperties).toBe(false);
        expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
      }
    }
  });
  it("T-243: needs_reply is in the attention item schema (required for the API, boolean or null); a missing one parses as unknown (null), a non-boolean is refused", () => {
    const item = (BRIEFING_OUTPUT_SCHEMA.schema as { properties: { attention: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.attention.items;
    expect(Object.keys(item.properties)).toContain("needs_reply");
    expect(item.required).toContain("needs_reply");
    const parse = (a: Record<string, unknown>) => parseBriefingOutput(JSON.stringify({ ...GOOD, attention: [{ ref: "r1", what: "w", why: "y", next: "n", ...a }] }));
    expect(parse({ needs_reply: false })).toMatchObject({ ok: true, value: { attention: [{ needs_reply: false }] } });
    expect(parse({ needs_reply: null })).toMatchObject({ ok: true, value: { attention: [{ needs_reply: null }] } });
    expect(parse({})).toMatchObject({ ok: true, value: { attention: [{ needs_reply: null }] } });
    expect(parse({ needs_reply: "no" })).toMatchObject({ ok: false });
  });
  it("replies and more_replies may be omitted (drafts off): no retry needed", () => {
    const rest: Record<string, unknown> = { ...GOOD };
    delete rest.replies;
    delete rest.more_replies;
    expect(parseBriefingOutput(JSON.stringify(rest))).toMatchObject({ ok: true, value: { replies: [], more_replies: [] } });
  });
  it("accepts a complete reply, plain, fenced, or after leading prose", () => {
    const json = JSON.stringify(GOOD);
    for (const text of [json, `  ${json}\n`, "```json\n" + json + "\n```", "```\n" + json + "\n```", `Here is the briefing:\n${json}`, `${json}\nHope that helps.`]) {
      expect(parseBriefingOutput(text)).toMatchObject({ ok: true });
    }
  });
  it("a malformed reply is not_json", () => {
    for (const text of ["", "no json here", '{"lines": ["cut off', "[1,2]"]) expect(parseBriefingOutput(text)).toEqual({ ok: false, issues: [{ path: "", code: "not_json" }] });
  });
  it("a partial reply lists the missing fields as paths and codes, never values", () => {
    const r = parseBriefingOutput(JSON.stringify({ lines: ["SECRET-VALUE"], attention: [{ ref: "r1", what: "SECRET-VALUE" }] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["attention.0.why", "attention.0.next", "deadlines", "priorities"]));
    expect(JSON.stringify(r.issues)).not.toContain("SECRET-VALUE");
    expect(r.issues.every((i) => typeof i.code === "string")).toBe(true);
  });
  it("a wrong enum value is rejected without echoing it", () => {
    const r = parseBriefingOutput(JSON.stringify({ ...GOOD, replies: [{ ref: "r1", status: "LEAKED", context: "c", text: "t" }] }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("LEAKED");
  });
  it("the correction message holds paths and codes only", () => {
    const m = correctionMessage([{ path: "attention.0.why", code: "invalid_type", expected: "string" }]);
    expect(m).toContain("attention.0.why: invalid_type (expected string)");
  });
});
