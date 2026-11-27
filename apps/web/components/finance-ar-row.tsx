"use client";
// T-300: one customer row of the aged receivables table with its open invoices that open under it. A real button (aria-expanded) toggles the
// detail row; the figures are rendered by the server and passed in. No customer id is in an address or in the DOM. Only components are
// exported from this "use client" module (a constant would reach the server as a reference, T-245).
import { useId, useState, type ReactNode } from "react";

export function ArRow({ rowClass, name, cells, children }: { rowClass: string; name: string; cells: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <div role="row" data-testid="finance-ar-row" className={`py-3 text-body ${rowClass}`}>
        <div role="rowheader" data-field="customer" className="flex items-center gap-2 font-medium text-foreground">
          <button type="button" aria-expanded={open} aria-controls={id} onClick={() => { setOpen((o) => !o); }} className="flex min-w-0 items-center gap-2 text-left">
            <span aria-hidden className={`text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}>›</span>
            <span className="min-w-0 truncate">{name}</span>
          </button>
        </div>
        {cells}
      </div>
      {open ? (
        <div role="row" id={id}>
          <div role="cell" aria-colspan={8} data-testid="finance-ar-detail" className="mb-3 ml-5 flex flex-col gap-2 rounded-control bg-muted/40 p-3">
            {children}
          </div>
        </div>
      ) : null}
    </>
  );
}
