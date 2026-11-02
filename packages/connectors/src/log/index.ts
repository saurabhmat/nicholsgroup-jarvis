// The shared connector logger (T-033). Every connector and the HTTP client (T-034) log through it, never through
// console directly, so every entry is redacted (./redact.ts) before it reaches stdout, Vercel logs or Sentry (T-041).
// Entries are one JSON line: level, event (dotted name), lane, provider, connection id, and redacted fields.
import type { LaneId } from "@nichols/core";
import { redactFields, redactText } from "./redact";

export { REDACTED, redactFields, redactText } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  level: LogLevel;
  event: string;
  at: string;
  lane_id?: LaneId;
  provider?: string;
  connection_id?: string;
  fields: Record<string, unknown>;
};

export type LogSink = (entry: LogEntry) => void;

export type LogContext = { laneId?: LaneId; provider?: string; connectionId?: string };

export interface ConnectorLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** A logger with more context (e.g. the connection) bound in. */
  child(context: LogContext): ConnectorLogger;
}

const EVENT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

const consoleSink: LogSink = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
};

export function createConnectorLogger(options: { sink?: LogSink; context?: LogContext; now?: () => Date } = {}): ConnectorLogger {
  const sink = options.sink ?? consoleSink;
  const context = options.context ?? {};
  const now = options.now ?? (() => new Date());
  const write = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    const entry: LogEntry = {
      level,
      event: EVENT.test(event) ? event : "connector.log",
      at: now().toISOString(),
      ...(context.laneId ? { lane_id: context.laneId } : {}),
      ...(context.provider ? { provider: redactText(context.provider) } : {}),
      ...(context.connectionId ? { connection_id: redactText(context.connectionId) } : {}),
      fields: redactFields(fields),
    };
    try {
      sink(entry);
    } catch {
      // logging must never break a sync or a request
    }
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (more) => createConnectorLogger({ sink, now, context: { ...context, ...more } }),
  };
}

/** The process-wide logger for connector code. */
export const connectorLog: ConnectorLogger = createConnectorLogger();
