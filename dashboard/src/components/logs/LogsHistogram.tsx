import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

const BUCKET_COUNT = 30;

// Histograma simples de volume de logs ao longo da janela de tempo pesquisada —
// mesmo padrão visual dos gráficos de Overview.tsx (BarChart/recharts, cores via
// CSS var). Bucketiza `rows` (já filtradas pela query) em BUCKET_COUNT baldes
// uniformes entre `from`/`to`.
export function LogsHistogram({ rows, from, to }: { rows: { ts: number }[]; from: number; to: number }) {
  const data = useMemo(() => {
    const span = Math.max(1, to - from);
    const bucketMs = span / BUCKET_COUNT;
    const buckets = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
      t: from + i * bucketMs,
      count: 0,
    }));
    for (const r of rows) {
      if (typeof r.ts !== "number") continue; // linha sem ts numérico não bucketiza (evita buckets[NaN])
      const idx = Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor((r.ts - from) / bucketMs)));
      buckets[idx].count++;
    }
    const showDate = span > 24 * 60 * 60 * 1000; // janela > 1 dia: rotula com data, não só hora
    return buckets.map((b) => ({
      label: new Date(b.t).toLocaleString("pt-BR", showDate ? { day: "2-digit", month: "2-digit", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" }),
      count: b.count,
    }));
  }, [rows, from, to]);

  return (
    <div className="h-24 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" allowDecimals={false} width={28} />
          <RTooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
          <Bar dataKey="count" fill="var(--chart-1)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
