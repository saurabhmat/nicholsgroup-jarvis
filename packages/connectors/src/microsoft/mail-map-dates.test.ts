// T-067 review: the shared timestamp parser refuses an impossible date instead of rolling it into the next month (mail and calendar both use it).
import { describe, expect, it } from "vitest";
import { instant } from "./mail-map";

describe("instant refuses impossible dates", () => {
  it("2026-02-30, 2026-04-31, 2026-13-01 and 2026-00-10 are unusable; real dates (incl. 2028-02-29) still parse", () => {
    for (const v of ["2026-02-30T00:00:00", "2026-04-31T10:00:00Z", "2026-13-01T10:00:00Z", "2026-00-10T10:00:00Z", "2027-02-29T00:00:00Z"]) expect(instant(v), v).toBeNull();
    expect(instant("2028-02-29T00:00:00")).toBe("2028-02-29T00:00:00.000Z");
    expect(instant("2026-11-04T10:00:00Z")).toBe("2026-11-04T10:00:00.000Z");
  });
});
