import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { serverTimingEnabled } from "./server";

describe("serverTimingEnabled", () => {
  it("accepts a trimmed 1 and nothing else", () => {
    expect(serverTimingEnabled({ NODE_ENV: "production", SERVER_TIMING: "1\t" })).toBe(true);
    expect(serverTimingEnabled({ NODE_ENV: "production", SERVER_TIMING: "1" })).toBe(true);
    expect(serverTimingEnabled({ NODE_ENV: "production", SERVER_TIMING: "true" })).toBe(false);
    expect(serverTimingEnabled({ NODE_ENV: "development\n" })).toBe(true);
  });
});
