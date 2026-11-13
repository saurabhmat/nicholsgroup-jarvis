// The shared QuickBooks error banner (T-197): fixed text per state and a "Contact support" link (mailto). Used by Settings ->
// Connections and, later, by the Finance page (T-084/T-092). The text never carries Intuit's wording, ids or any figure.
import { ErrorBanner } from "@nichols/ui";
import { SUPPORT_EMAIL, SUPPORT_HREF } from "@/lib/support";

export { SUPPORT_EMAIL, SUPPORT_HREF };

export type QuickBooksBannerKind = "reconnect_required" | "degraded" | "unavailable";

const TEXT: Record<QuickBooksBannerKind, { title: string; description: string; subject: string }> = {
  reconnect_required: {
    title: "QuickBooks needs to be reconnected",
    description: "QuickBooks access was withdrawn or has expired, so the books are no longer syncing. Use Reconnect QuickBooks on the affected connection.",
    subject: "QuickBooks needs to be reconnected",
  },
  degraded: {
    title: "QuickBooks is connected, with problems",
    description: "The last attempts to read QuickBooks failed, so the figures may be out of date. It tries again on its own; if this stays, download the error log below and contact support.",
    subject: "QuickBooks connected with problems",
  },
  unavailable: {
    title: "QuickBooks connection status is unavailable",
    description: "The portal could not read the connection status just now. Reload the page in a minute; if it keeps happening, contact support.",
    subject: "QuickBooks connection status unavailable",
  },
};

export function QuickBooksErrorBanner({ kind }: { kind: QuickBooksBannerKind }) {
  const t = TEXT[kind];
  return <ErrorBanner title={t.title} description={t.description} supportEmail={SUPPORT_EMAIL} supportSubject={t.subject} />;
}
