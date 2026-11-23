// The text a failed Teams Disconnect shows, chosen by the HTTP status only (never the server's reply). A plain module so the client button and the tests share it.
const BY_STATUS: Record<number, string> = {
  401: "You are signed out. Sign in again and retry.",
  403: "Only the person who connected this account can disconnect it, and only when you are signed in with two-step verification. Sign in again and retry.",
  404: "That account was not found. Reload the page.",
};
export const teamsDisconnectErrorText = (status: number): string => BY_STATUS[status] ?? "That did not work. Reload the page and try again.";
