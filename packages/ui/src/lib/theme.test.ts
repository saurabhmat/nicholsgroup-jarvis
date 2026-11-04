import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, readTheme, THEME_INIT } from "./theme";

const root = () => document.documentElement;

describe("theme choice", () => {
  beforeEach(() => {
    localStorage.clear();
    root().removeAttribute("data-theme");
  });

  it("defaults to the system setting and sets nothing", () => {
    expect(readTheme()).toBe("system");
    new Function(THEME_INIT)();
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("persists light or dark in localStorage and sets data-theme", () => {
    applyTheme("dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(readTheme()).toBe("dark");
    root().removeAttribute("data-theme");
    new Function(THEME_INIT)(); // the pre-paint script restores it
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("system clears the choice; junk values are ignored", () => {
    applyTheme("light");
    applyTheme("system");
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("theme")).toBeNull();
    localStorage.setItem("theme", "<script>");
    new Function(THEME_INIT)();
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(readTheme()).toBe("system");
  });
});
