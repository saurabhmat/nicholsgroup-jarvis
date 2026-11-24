import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("Button disabled looks (T-297 review M5)", () => {
  it("`aria-disabled` looks and behaves like `disabled` (a busy button that keeps the keyboard focus is still seen as busy)", () => {
    const c = buttonVariants();
    for (const k of ["disabled:pointer-events-none", "disabled:opacity-50", "aria-disabled:pointer-events-none", "aria-disabled:opacity-50"]) expect(c).toContain(k);
  });
});
