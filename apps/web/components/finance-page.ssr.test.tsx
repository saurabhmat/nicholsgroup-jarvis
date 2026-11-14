// T-245: the Finance page rendered on the server (react-dom/server, as Next's SSR does) with synthetic data (rule 10).
// Production crashed with `PERIODS.map is not a function` because a constant came from a "use client" module; the static check
// is tests/directive-exports.test.ts. This file renders the whole view server-side and checks that one failing card is contained.
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PERIODS } from "@nichols/ui";
import { FinanceView, type FinanceData } from "./finance-page";
import { data } from "./finance-page.fixtures";

async function ssr(d: FinanceData): Promise<{ html: string; errors: unknown[] }> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(<FinanceView laneId="PKG" laneName="Pub K Group" period="mtd" data={d} />, {
    onError: (e) => {
      errors.push(e);
    },
  });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

/** Data whose P&L throws when read, as a broken card would. */
function brokenPnl(): FinanceData {
  const d = data();
  return {
    ...d,
    get pnl(): FinanceData["pnl"] {
      throw new TypeError("synthetic card failure");
    },
  };
}

describe("Finance page, server-side render", () => {
  it("renders every card, section and the period links on the server", async () => {
    expect(Array.isArray(PERIODS)).toBe(true);
    const { html, errors } = await ssr(data());
    expect(errors).toEqual([]);
    for (const label of ["Cash", "Accounts receivable", "Bills due in 14 days", "Net income", "Subscriptions", "Receivables aging", "Cash by account", "Controls", "Reports"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("$2,001.00");
    expect(html).toContain("$600.00");
    for (const p of PERIODS) expect(html).toContain(p.label);
    expect(html).not.toContain("Could not load");
    // Large sections may stream after the shell; each one's real content is in the document by the end.
    expect(html).toContain("Total open receivables");
    expect(html).toContain("QuickBooks connection");
    expect(html).toContain("Profit and loss");
  });

  it("a card that throws is contained on the server: that card falls back, the rest of the page renders", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { html, errors } = await ssr(brokenPnl());
      expect(errors).toHaveLength(1);
      // The server sends the card's fallback and marks it for a client retry; the client error boundary then shows "could not load".
      expect(html).toMatch(/Net income<\/h2>[\s\S]{0,400}Loading…/);
      expect(html).toContain("$2,001.00");
      expect(html).toContain("$410.50");
      expect(html).toContain("Receivables aging");
      expect(html).not.toContain("$600.00");
    } finally {
      quiet.mockRestore();
    }
  });
});
