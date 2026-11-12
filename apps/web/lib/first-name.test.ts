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
  const g = { requireLane: async () => ({ client: {}, session: { userId: "u1" } }) } as never;
  it("returns the first name from the loaded profile", async () => {
    expect(await firstNameFor(g, "PKG", async (_c, id) => (id === "u1" ? "Dana" : undefined))).toBe("Dana");
  });
  it("reads the verified session user's row, whoever else is named", async () => {
    const seen: string[] = [];
    await firstNameFor(g, "PKG", async (_c, id) => { seen.push(id); return undefined; });
    expect(seen).toEqual(["u1"]);
  });
  it("never throws: a failed read leaves no name", async () => {
    expect(await firstNameFor(g, "PKG", async () => { throw new Error("x"); })).toBeUndefined();
  });
});
