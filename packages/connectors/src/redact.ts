// Public redaction entry point (`@nichols/connectors/redact`, T-033 review M6): the same scrubbing the connector
// logger uses, for code outside packages/connectors that writes out text (Sentry beforeSend, T-041 / T-196).
// Only the text and field redactors: the secret registry and the logger stay internal.
export { REDACTED, redactFields, redactText } from "./log/redact";
