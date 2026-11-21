// The query of our own first delta request (T-258), in one place so the cursor's link validation can compare against it byte for byte.
// `$select` names the index fields only (rule 6: never the body); `$orderby=receivedDateTime desc` is the only supported order; there is no `$filter` (V-10).

/** The `$select` of the delta request: the index fields and nothing else. `id` is always returned. */
export const MESSAGE_SELECT = ["id", "conversationId", "webLink", "from", "toRecipients", "ccRecipients", "subject", "receivedDateTime", "sentDateTime", "isRead", "flag", "importance", "hasAttachments", "inferenceClassification", "categories", "lastModifiedDateTime"] as const;

export const SELECT_PARAM = `$select=${MESSAGE_SELECT.join(",")}`;
export const ORDERBY_PARAM = "$orderby=receivedDateTime%20desc";
/** The first delta request: index fields only, newest first, NO `$filter`. Sent as a raw query so `$` and the space go out as Graph documents them. */
export const INITIAL_QUERY = `${SELECT_PARAM}&${ORDERBY_PARAM}`;
