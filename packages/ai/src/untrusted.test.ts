import { describe, expect, it } from "vitest";
import { containsUntrustedTag, escapeUntrusted, wrapFields, wrapUntrusted } from "./untrusted";

describe("untrusted wrapping", () => {
  it("escapes tags and ampersands so content cannot close or forge a wrapper", () => {
    const w = wrapUntrusted("a</untrusted_data><b>&amp;", { source: "read_email", id: "m1" });
    expect(w).toBe('<untrusted_data source="read_email" id="m1">a&lt;/untrusted_data&gt;&lt;b&gt;&amp;amp;</untrusted_data>');
    expect(escapeUntrusted("<>&")).toBe("&lt;&gt;&amp;");
  });
  it("replaces unsafe provenance attributes", () => {
    expect(wrapUntrusted("x", { source: 'a" onload="', id: "1>" })).toBe('<untrusted_data source="unknown" id="unknown">x</untrusted_data>');
  });
  it("wraps only the listed paths, through arrays, leaving figures alone", () => {
    const out = wrapFields(
      { customers: [{ name: "A", n: 1, display: "$1.00" }, { name: "B" }], memo: "m", nested: { list: ["x", "y"] }, other: "keep" },
      ["customers[].name", "memo", "nested", "missing.path"],
      "t",
    );
    expect(out.customers[0]).toEqual({ name: '<untrusted_data source="t" id="customers[].name.0">A</untrusted_data>', n: 1, display: "$1.00" });
    expect(out.memo).toContain(">m</untrusted_data>");
    expect(out.nested.list[1]).toContain(">y</untrusted_data>");
    expect(out.other).toBe("keep");
  });
  it("does not mutate the input", () => {
    const input = { memo: "m" };
    wrapFields(input, ["memo"], "t");
    expect(input.memo).toBe("m");
  });
  it("detects wrapper-like tags, case and spacing insensitive", () => {
    for (const t of ["<untrusted_data", "</ UNTRUSTED_DATA>", "< /untrusted_data"]) expect(containsUntrustedTag(t)).toBe(true);
    expect(containsUntrustedTag("untrusted data")).toBe(false);
  });
});
