// Fixed Microsoft wording that follows the scopes the connect actually requests (T-257 review). `writes` comes from the same scope list that builds the
// admin consent link and the connect (`microsoftConnectInfo`): false = read scopes only; true = the lane policy allows email writes, so the app also
// asks to create and send mail; null = not known here (paused, status unread, or a result banner with no lane context): nothing is claimed either way.
// "Read-only" is only ever said for `false`. Google's texts are not built here.
export type MicrosoftWrites = boolean | null;

const NOT_SIGN_IN = "It is not how anyone signs in to the portal.";

/** What the connection is, as one or two sentences. */
export function microsoftConnects(writes: MicrosoftWrites): string {
  if (writes === false) return `This connects your mail and calendar, read-only. ${NOT_SIGN_IN}`;
  if (writes === true) {
    return `This connects your mail and calendar and, because this company has email replies switched on, also asks permission to create and send mail, which still only happens after approval in the portal. ${NOT_SIGN_IN}`;
  }
  return `This connects your mail and calendar. ${NOT_SIGN_IN}`;
}

/** The short line under the provider name of a row. */
export const microsoftRowSub = (writes: MicrosoftWrites): string => (writes === false ? "Mail and calendar, read-only" : "Mail and calendar");

/** What the admin consent link asks for. */
export function microsoftConsentAsks(writes: MicrosoftWrites): string {
  return writes === false
    ? "It only asks for read-only mail and calendar permissions."
    : "It asks for the mail and calendar permissions this connect uses, including creating and sending mail (which still only happens after approval in the portal).";
}
