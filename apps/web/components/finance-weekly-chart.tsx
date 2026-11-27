"use client";
// T-301: the grouped bar chart of the weekly report (Recharts): two bars per week, invoiced and received, oldest week on the left. It is
// decoration: the table beside it carries every figure, so the whole chart is hidden from a screen reader. The figures are SQL's, passed
// as numbers; nothing is computed here. Only components are exported from this "use client" module (a constant would reach the server as
// a reference, T-245). `initialDimension` makes the chart render on the server, so the server-rendered page holds the SVG.
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";

export type WeeklyChartPoint = { label: string; invoiced: number; received: number };

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1, style: "currency", currency: "USD" });

export function WeeklyChart({ points }: { points: WeeklyChartPoint[] }) {
  return (
    <div aria-hidden="true" data-testid="finance-weekly-chart" className="w-full min-w-0">
      {/* The legend is plain text beside the colours (the two series differ by more than colour) and is in the server-rendered page. */}
      <ul data-testid="finance-weekly-legend" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-foreground">
        <li className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: "var(--chart-1)" }} />Invoiced (left bar)</li>
        <li className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: "var(--chart-2)" }} />Received (right bar)</li>
      </ul>
      <div className="h-56 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 224 }}>
        <BarChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} interval="preserveStartEnd" />
          <YAxis tickLine={false} axisLine={false} fontSize={12} width={56} tickFormatter={(v: number) => compact.format(v)} />
          <Bar dataKey="invoiced" name="Invoiced" fill="var(--chart-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="received" name="Received" fill="var(--chart-2)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}
