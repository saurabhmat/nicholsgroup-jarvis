// The export URL helper, kept apart from the route logic so a client component (Settings -> Connections, T-197) can use it
// without pulling the server-only handler into the browser bundle.
export type ExportFormat = "csv" | "json";
export type ExportDataset = "errors" | "runs";

/** The export URL for Settings -> Connections (T-197): same-origin, relative. Dates are YYYY-MM-DD (America/New_York days, `to` inclusive). */
export function connectorErrorExportUrl(laneId: string, input: { from: string; to: string; format?: ExportFormat; dataset?: ExportDataset }): string {
  const p = new URLSearchParams({ from: input.from, to: input.to, format: input.format ?? "csv", dataset: input.dataset ?? "errors" });
  return `/api/lanes/${encodeURIComponent(laneId)}/connector-errors/export?${p.toString()}`;
}
