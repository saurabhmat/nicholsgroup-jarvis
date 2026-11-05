// Test helper: a logger that records its entries (T-036 tests).
import { createConnectorLogger, type LogEntry } from "../log/index";

export function createLogCapture() {
  const entries: LogEntry[] = [];
  return { entries, logger: createConnectorLogger({ sink: (e) => void entries.push(e) }) };
}
