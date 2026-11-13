"use client";
// "Download error log" (T-197): the lane's QuickBooks API errors for a date range, as CSV or JSON, for Intuit support. The links
// go to T-196's export route (owner or admin_technical at AAL2, audited, 90 days at most). Nothing is fetched in the page itself.
import { useState } from "react";
import { buttonVariants } from "@nichols/ui";
import { connectorErrorExportUrl } from "@/lib/connector-error-export-url";
import { checkExportRange } from "@/lib/quickbooks-export-range";

const input = "min-h-11 rounded-control border border-border bg-card px-3 py-2 text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

export function QuickBooksErrorExport({ laneId, defaultFrom, defaultTo }: { laneId: string; defaultFrom: string; defaultTo: string }) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const check = checkExportRange(from, to);
  const link = (format: "csv" | "json") =>
    check.ok ? (
      <a href={connectorErrorExportUrl(laneId, { from, to, format })} download className={buttonVariants({ variant: "outline" })}>
        Download {format.toUpperCase()}
      </a>
    ) : (
      <span aria-disabled="true" className={`${buttonVariants({ variant: "outline" })} pointer-events-none opacity-50`}>
        Download {format.toUpperCase()}
      </span>
    );
  return (
    <div data-testid="qbo-error-export" className="flex flex-col gap-2">
      <p className="text-small font-medium text-foreground">Error log for support</p>
      <p className="text-small text-muted-foreground">The errors QuickBooks returned to the portal, for Intuit support. No names, amounts or tokens. Up to 90 days.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-small font-medium text-foreground">
          From
          <input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="grid gap-1 text-small font-medium text-foreground">
          To
          <input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {link("csv")}
        {link("json")}
      </div>
      {!check.ok ? (
        <p role="alert" className="text-small text-alert-foreground">
          {check.message}
        </p>
      ) : null}
    </div>
  );
}
