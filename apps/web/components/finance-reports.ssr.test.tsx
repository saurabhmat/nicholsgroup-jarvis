// T-300, T-301: the Receivables and Invoices & payments pages rendered on the server (react-dom/server, as Next's SSR does) with
// synthetic data (rule 10). The weekly chart is a client component (Recharts): the server-rendered document must hold its SVG and render
// without errors. The static check for constants exported from "use client" modules is tests/directive-exports.test.ts.
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReceivablesView } from "./finance-receivables";
import { WeeklyView, type WeeklyData } from "./finance-weekly";
import { receivables, weekly } from "./finance-reports.fixtures";
import type { Receivables } from "@/lib/finance-reports";

async function ssr(node: React.ReactElement): Promise<{ html: string; errors: unknown[] }> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(node, { onError: (e) => { errors.push(e); } });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

describe("Receivables page, server-side render", () => {
  it("renders the tabs, the customer rows, the totals row and the check line without errors", async () => {
    const { html, errors } = await ssr(<ReceivablesView laneId="PKG" laneName="Pub K Group" data={receivables()} />);
    expect(errors).toEqual([]);
    for (const text of ["Overview", "Receivables", "Invoices &amp; payments", "Alpha Co", "Beta Co", "Unknown customer", "$361.36", "$300.30", "QuickBooks AR aging report, as of Nov 27, 2026: $360.00", "$1.36"]) expect(html).toContain(text);
    expect(html).not.toContain("Could not load");
  });

  it("a row that throws is contained: the section falls back, the header and tabs render", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const good = receivables();
      const broken = {
        ...good,
        get customers(): never {
          throw new TypeError("synthetic card failure");
        },
      } as unknown as Receivables;
      const { html, errors } = await ssr(<ReceivablesView laneId="PKG" laneName="Pub K Group" data={broken} />);
      expect(errors).toHaveLength(1);
      expect(html).toContain("Finance");
      expect(html).toContain("Invoices &amp; payments");
      expect(html).not.toContain("$361.36");
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("Invoices & payments page, server-side render", () => {
  it("renders the tabs, the chart container, the weekly table and the chosen week without errors", async () => {
    const { html, errors } = await ssr(<WeeklyView laneId="PKG" laneName="Pub K Group" data={weekly({ week: "2026-11-14" })} />);
    expect(errors).toEqual([]);
    expect(html).toContain("finance-weekly-chart");
    // Recharts 3 draws its SVG after it has measured the container in the browser: the server document holds the sized wrapper (no layout
    // jump), not the bars. The table below carries every figure, so nothing is missing from the server-rendered page.
    expect(html).toContain("recharts-wrapper");
    for (const text of ["Nov 21, 2026 – Nov 27, 2026", "$1,000.50", "$100.01", "Eps Co", "Delta Co", "Not included: sales receipts, credit memos and refunds are not synced"]) expect(html).toContain(text);
    expect(html).not.toContain("Could not load");
  });

  it("a failing week table is contained", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const d = weekly();
      const w = d.weekly;
      if (w.state !== "ok") throw new Error("fixture");
      const broken: WeeklyData = {
        ...d,
        weekly: {
          ...w,
          get weeks(): never {
            throw new TypeError("synthetic card failure");
          },
        },
      };
      const { html, errors } = await ssr(<WeeklyView laneId="PKG" laneName="Pub K Group" data={broken} />);
      expect(errors).toHaveLength(1);
      expect(html).toContain("Invoices &amp; payments");
      expect(html).not.toContain("$1,000.50");
    } finally {
      quiet.mockRestore();
    }
  });
});
