// Settings sub-navigation (T-230 B): in-page anchors to the sections the user can see. A column on the left from lg up;
// a row of chips above the content on iPhone. Only sections that are drawn get an entry (the loaders decide that).
export type SettingsNavItem = { id: string; label: string };

export function SettingsNav({ items }: { items: SettingsNavItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Settings sections" data-testid="settings-nav" className="lg:sticky lg:top-8 lg:self-start">
      <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={`#${i.id}`}
              className="inline-flex min-h-11 items-center rounded-full border border-border bg-card px-4 text-body font-medium text-foreground hover:bg-primary-tint lg:flex lg:rounded-control lg:border-transparent lg:bg-transparent lg:px-3"
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
