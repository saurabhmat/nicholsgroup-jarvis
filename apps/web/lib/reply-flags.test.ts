import { describe, expect, it } from "vitest";
import { flagRecipients } from "./reply-flags";

describe("flagRecipients domain rule (last @)", () => {
  it("an address with a second @ takes the domain after the LAST @ (so it is external here)", () => {
    const f = flagRecipients({ to: ["ceo@pubk.test@evil.test"], cc: [], bcc: [] }, ["pubk.test"]);
    expect(f).toEqual([{ address: "ceo@pubk.test@evil.test", field: "to", flags: ["external"] }]);
  });
  it("an internal address is not flagged; a Bcc always is", () => {
    expect(flagRecipients({ to: ["a@pubk.test"], cc: [], bcc: ["b@pubk.test"] }, ["pubk.test"])).toEqual([{ address: "b@pubk.test", field: "bcc", flags: ["bcc"] }]);
  });
});
