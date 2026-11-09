import { describe, expect, it } from "vitest";
import { firstIncomplete, initialStage, stageAfter, stageBefore } from "./onboarding-wizard";

const groups = (doneIds: string[]) => ["A-1", "A-2", "A-3", "B-1"].map((id) => ({ id, done: doneIds.includes(id) }));

describe("wizard stages", () => {
  it("opens the intro on a fresh start", () => {
    expect(initialStage(groups([]), undefined, false)).toEqual({ kind: "intro" });
  });
  it("deep link to a valid step opens exactly that step (even when it is done or the first)", () => {
    expect(initialStage(groups([]), "A-3", true)).toEqual({ kind: "group", id: "A-3" });
    expect(initialStage(groups(["A-1", "A-2", "A-3", "B-1"]), "A-1", true)).toEqual({ kind: "group", id: "A-1" });
  });
  it("an unknown step falls back to the first incomplete step (never the intro, never the raw value)", () => {
    expect(initialStage(groups(["A-1"]), undefined, true)).toEqual({ kind: "group", id: "A-2" });
    expect(initialStage(groups([]), undefined, true)).toEqual({ kind: "group", id: "A-1" });
    expect(initialStage(groups(["A-1"]), "../x", true)).toEqual({ kind: "group", id: "A-2" });
  });
  it("returning with progress and no step resumes at the first incomplete step; all done opens the finish screen", () => {
    expect(initialStage(groups(["A-1", "A-2"]), undefined, false)).toEqual({ kind: "group", id: "A-3" });
    expect(initialStage(groups(["A-1", "A-2", "A-3", "B-1"]), undefined, false)).toEqual({ kind: "finish" });
  });
  it("moves between steps in bank order", () => {
    const g = groups([]);
    expect(stageAfter(g, "A-2")).toEqual({ kind: "group", id: "A-3" });
    expect(stageAfter(g, "B-1")).toEqual({ kind: "finish" });
    expect(stageBefore(g, "A-2")).toEqual({ kind: "group", id: "A-1" });
    expect(stageBefore(g, "A-1")).toEqual({ kind: "intro" });
    expect(firstIncomplete(groups(["A-1"]))).toBe("A-2");
    expect(firstIncomplete(groups(["A-1", "A-2", "A-3", "B-1"]))).toBe("A-1");
  });
});
