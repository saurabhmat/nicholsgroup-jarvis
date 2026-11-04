// Theme choice (T-023): light, dark, or the system setting (default). The choice is a UI preference kept in this
// browser's localStorage only, never in lane data. THEME_INIT runs in <head> before first paint, so there is no flash:
// with no saved choice it sets nothing and the tokens follow prefers-color-scheme; with one it sets data-theme on <html>.
export const THEME_KEY = "theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_INIT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage blocked: the choice applies for this page only
  }
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}
