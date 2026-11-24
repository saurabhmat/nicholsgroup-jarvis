import { describe, expect, it } from "vitest";
import { CONNECT_ROLES, MAIL_CONNECT_ROLES, connectRolesFor } from "./flow";

describe("connectRolesFor (T-254)", () => {
  it("microsoft and google: any member with own_mail connects their own account", () => {
    expect(connectRolesFor("microsoft")).toBe(MAIL_CONNECT_ROLES);
    expect(connectRolesFor("google")).toBe(MAIL_CONNECT_ROLES);
    expect([...MAIL_CONNECT_ROLES]).toEqual(["owner", "admin_technical", "viewer"]);
  });

  it("every other provider (QuickBooks, unknown, empty) still needs owner or admin_technical", () => {
    for (const p of ["quickbooks", "stripe", "gohighlevel", "Microsoft", ""]) {
      expect(connectRolesFor(p)).toBe(CONNECT_ROLES);
    }
    expect([...CONNECT_ROLES]).toEqual(["owner", "admin_technical"]);
  });
});

describe("T-278: a person's own Teams account", () => {
  it("is connected by any own_mail member, like their own mailbox", async () => {
    const { connectRolesFor, MAIL_CONNECT_ROLES } = await import("./flow");
    expect(connectRolesFor("microsoft_teams")).toBe(MAIL_CONNECT_ROLES);
  });
});
