"use client";
// Theme control for the user menu (T-023): System / Light / Dark. Colours come from the @nichols/ui tokens only.
import { useSyncExternalStore } from "react";
import { applyTheme, readTheme, THEMES, type Theme } from "@nichols/ui";

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb));

export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme>(subscribe, readTheme, () => "system");
  return (
    <div role="group" aria-label="Theme" className="flex gap-1 text-small">
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={theme === t}
          onClick={() => {
            applyTheme(t);
            listeners.forEach((l) => l());
          }}
          className="flex-1 rounded-control border border-sidebar-switcher-border min-h-11 px-2 py-1 capitalize hover:bg-sidebar-switcher aria-pressed:bg-sidebar-active aria-pressed:font-semibold aria-pressed:text-sidebar-strong"
        >
          {t}
        </button>
      ))}
    </div>
  );
}
