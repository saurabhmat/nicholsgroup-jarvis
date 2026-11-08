import { describe, expect, it } from "vitest";
import { extractIdentity } from "./identity";

describe("extractIdentity (T-219)", () => {
  it("reads an address from the known keys, lower-cased, at the top level or one or two wrappers down", () => {
    expect(extractIdentity({ emailAddress: "Boss@Example.test" })).toBe("boss@example.test");
    expect(extractIdentity({ email: "a@example.test" })).toBe("a@example.test");
    expect(extractIdentity({ response_data: { emailAddress: "b@example.test" } })).toBe("b@example.test");
    expect(extractIdentity({ data: { details: { email: "c@example.test" } } })).toBe("c@example.test");
    expect(extractIdentity({ id: "primary-cal@example.test" })).toBe("primary-cal@example.test");
  });
  it("accepts nothing that is not a plain email address (fail closed)", () => {
    for (const bad of [null, undefined, "a@b.test", 5, [], {}, { emailAddress: "not an email" }, { emailAddress: 7 }, { id: "primary" }, { x: { y: { z: { email: "deep@example.test" } } } }, { emailAddress: "a@b.test, c@d.test" }]) {
      expect(extractIdentity(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
