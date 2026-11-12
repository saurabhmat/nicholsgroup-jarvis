import { describe, expect, it } from "vitest";
import { firstNameFor, firstNameOf } from "./first-name";

describe("firstNameOf", () => {
  it.each([
    ["Synthetic Owner", "Synthetic"],
    ["  Dana   Example ", "Dana"],
    ["Dr. Dana Example", "Dana"],
    ["Cher", "Cher"],
  ])("%s -> %s", (input, out) => expect(firstNameOf(input)).toBe(out));
  it.each([[null], [undefined], [""], ["   "], ["owner@example.test"], [42], ["Dr."]])("%s -> no name", (input) => expect(firstNameOf(input)).toBeUndefined());
});

describe("firstNameFor", () => {
  const g = { requireLane: async () => ({ client: {} }) } as never;
  it("returns the first name from the loaded profile", async () => {
    expect(await firstNameFor(g, "PKG", "u1", async (_c, id) => (id === "u1" ? "Dana" : undefined))).toBe("Dana");
  });
  it("never throws: a failed read leaves no name", async () => {
    expect(await firstNameFor(g, "PKG", "u1", async () => { throw new Error("x"); })).toBeUndefined();
  });
});
