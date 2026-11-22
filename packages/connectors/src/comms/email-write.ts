// What the Google and Microsoft email writers share (T-232, T-262): the two fixed messages the approvals module recognises, and the name of the
// header that carries the action id. Pure constants: no provider code, no I/O.
export const OUTCOME_UNKNOWN_MESSAGE = "The send outcome is unknown; check the mailbox before trying again";
export const VERIFICATION_MISMATCH_MESSAGE = "The message in the mailbox does not match the approved action";
export const PORTAL_ACTION_HEADER = "X-Portal-Action-Id";
