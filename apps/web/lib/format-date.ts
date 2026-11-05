// Display date for the Home eyebrow ("Monday, November 30"). The business calendar is America/New_York (rule 11).
const BUSINESS_TZ = "America/New_York";

export function eyebrowDate(now: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: BUSINESS_TZ }).format(now);
}
