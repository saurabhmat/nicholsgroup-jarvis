// Which provider and account a mail or calendar row came from (T-260, T-261, D-57). Pure text helpers: the provider is the one on the
// row's own CONNECTION (never "the lane's provider"), the account is the mailbox address Coverage reports for that connection. Names are
// fixed here, never taken from provider data (rule 9), and an unknown provider has no name, so nothing is invented for it.
// Labels are shown only when the viewer has a connection that is not Google's (see `needsSourceLabels`): a Google-only lane keeps
// exactly the screens it had before Microsoft existed.

export type SourceKind = "mail" | "calendar";

/** The provider and mailbox address of one connection, as Coverage reports them. */
export type SourceTag = { provider: string; account: string };

const NAMES: Readonly<Record<string, { mail: string; calendar: string }>> = Object.freeze({
  google: { mail: "Gmail", calendar: "Google Calendar" },
  microsoft: { mail: "Outlook", calendar: "Outlook" },
});

/** "Gmail", "Google Calendar" or "Outlook" for a known provider and stream; null for anything else. */
export function sourceName(provider: string | null | undefined, kind: SourceKind): string | null {
  return typeof provider === "string" && Object.hasOwn(NAMES, provider) ? (NAMES[provider]?.[kind] ?? null) : null;
}

/** "Open in Gmail", "Open in Outlook" or "Open in Google Calendar"; null for an unknown provider. */
export function openInText(provider: string | null | undefined, kind: SourceKind): string | null {
  const name = sourceName(provider, kind);
  return name === null ? null : `Open in ${name}`;
}

/** "Outlook · robert@example.test" (the provider's name and the account); the name alone when the account is unknown; null for an unknown provider. */
export function sourceLabel(tag: { provider: string | null | undefined; account: string | null | undefined }, kind: SourceKind): string | null {
  const name = sourceName(tag.provider, kind);
  if (name === null) return null;
  return typeof tag.account === "string" && tag.account.trim() !== "" ? `${name} · ${tag.account}` : name;
}

/**
 * Whether rows carry a provider label: the viewer has at least one mail or calendar connection of a provider other than Google. A
 * Google-only viewer sees no label anywhere (every screen stays as it was); one with a Microsoft connection sees every row labelled,
 * Google rows included, so the two kinds read alike.
 */
export function needsSourceLabels(providers: Iterable<string | null | undefined>): boolean {
  for (const p of providers) if (typeof p === "string" && p !== "google" && Object.hasOwn(NAMES, p)) return true;
  return false;
}

/** Coverage's provider-and-account per connection id, for one stream. Rows without a connection or provider are left out. */
export function sourceTags(items: readonly { stream: SourceKind; connectionId: string | null; provider: string | null; account: string }[], stream: SourceKind): Record<string, SourceTag> {
  const out: Record<string, SourceTag> = {};
  for (const c of items) if (c.stream === stream && c.connectionId !== null && c.provider !== null) out[c.connectionId] = { provider: c.provider, account: c.account };
  return out;
}
