// The failed-scheduled-function banner (T-238 part E), for owner and admin_technical on Home and Settings -> Connections.
// "Mail sync has failed 3 times in a row since 9:15 AM ET." plus a fixed sentence for the last error when it is a known code, a link
// to Settings -> Connections and Contact support. Plain text only; it clears on its own after the next successful run.
import { ErrorBanner, laneHref } from "@nichols/ui";
import { SUPPORT_EMAIL } from "@/lib/support";
import { failureSentence, type JobFailureItem } from "@/lib/job-failures";

export function JobFailureBanner({ laneId, items, now = new Date(), onSettings = false }: { laneId: string; items: JobFailureItem[] | null; now?: Date; onSettings?: boolean }) {
  if (!items || items.length === 0) return null;
  const href = onSettings ? "#connections" : `${laneHref(laneId, "settings")}#connections`;
  const description = items.map((i) => `${failureSentence(i, now)}${i.detail ? ` Last error: ${i.detail}` : ""}`).join(" ");
  return (
    <div data-testid="job-failure-banner">
      <ErrorBanner
        title={items.length === 1 ? "A scheduled sync keeps failing" : "Scheduled syncs keep failing"}
        description={description}
        supportEmail={SUPPORT_EMAIL}
        supportSubject="Scheduled sync keeps failing"
        action={
          <a href={href} data-testid="job-failure-settings-link" className="text-body font-medium underline underline-offset-4">
            Open Settings
          </a>
        }
      />
    </div>
  );
}
