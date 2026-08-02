// Tela de Logs estilo CloudWatch Logs Insights: janela de tempo + uma única
// query box (mini-linguagem `fields | filter | sort | limit`, ver
// app/src/dashboard/queryLang.ts) que define de uma vez colunas, filtros,
// ordenação e limite — sem widgets dispersos (nada de picker de coluna, linhas
// de filtro soltas ou dropdown de ordenação separados). Modo "Ao vivo" é uma
// tela separada (tail via SSE) — misturar os dois paradigmas (busca paginada
// vs. tail contínuo) na mesma tabela ficava confuso.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconFileText, IconPlayerPlay } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { TimeRangePicker, relativeRange, type TimeRange } from "@/components/TimeRangePicker";
import { LogsTable, type LogRow } from "@/components/logs/LogsTable";
import { LogsHistogram } from "@/components/logs/LogsHistogram";
import { queryApi, logsApi } from "@/lib/api";
import { useSse } from "@/lib/useSse";

const DEFAULT_QUERY = "fields ts, level, feature, msg\n| sort ts desc\n| limit 50";
const DEFAULT_COLUMNS = ["ts", "level", "feature", "msg"];
const INTERNAL_FIELDS = new Set(["id", "fields_json", "raw", "service", "pid", "hostname"]);

const QUERY_HELP =
  'Comandos separados por "|": fields campo, campo — escolhe as colunas (na ordem digitada) · ' +
  'filter campo op valor (op: =, !=, >, >=, <, <=, like; junte várias com "and") · ' +
  "sort campo asc|desc · limit N. Ctrl/Cmd+Enter roda a query.";

export function Logs() {
  const [live, setLive] = useState(false);

  const [range, setRange] = useState<TimeRange>(() => relativeRange("1h"));
  const [queryText, setQueryText] = useState(DEFAULT_QUERY);
  const [applied, setApplied] = useState(() => ({ query: DEFAULT_QUERY, range: relativeRange("1h") }));
  const [page, setPage] = useState(1);
  const [discoveredFields, setDiscoveredFields] = useState<Set<string>>(new Set());

  const spec = useMemo(
    () => ({ query: applied.query, from: applied.range.from, to: applied.range.to, page }),
    [applied, page]
  );

  const { data, isFetching, error } = useQuery({
    queryKey: ["logs-query", spec],
    queryFn: () => queryApi.run("log_lines", spec),
    enabled: !live,
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    for (const row of data?.rows ?? []) {
      const full = JSON.parse((row as LogRow).fields_json || "{}");
      setDiscoveredFields((prev) => {
        const next = new Set(prev);
        for (const k of Object.keys(full)) {
          if (!INTERNAL_FIELDS.has(k)) next.add(k);
        }
        return next;
      });
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const runQuery = () => {
    // Janela relativa (15m/1h/...) é reavaliada AGORA, não no clique do preset —
    // igual ao CloudWatch: rodar de novo 20min depois busca os últimos 15m/1h a
    // partir deste momento, não a janela congelada de quando o preset foi
    // escolhido. "custom" (from/to absolutos) fica como está.
    const effective = range.label === "custom" ? range : relativeRange(range.label);
    setRange(effective);
    setPage(1);
    setApplied({ query: queryText, range: effective });
  };

  const insertField = (field: string) => {
    setQueryText((prev) => {
      const lines = prev.split("\n");
      const idx = lines.findIndex((l) => /^\s*fields\b/i.test(l.trim()));
      if (idx === -1) return `fields ${field}\n${prev}`;
      const line = lines[idx].trim();
      const hasPipe = /\|\s*$/.test(line);
      const argsStr = line.replace(/\|\s*$/, "").replace(/^fields\s*/i, "");
      const existing = argsStr
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      if (existing.includes(field)) return prev; // já presente
      lines[idx] = `fields ${[...existing, field].join(", ")}${hasPipe ? " |" : ""}`;
      return lines.join("\n");
    });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const columns = data?.fields ?? DEFAULT_COLUMNS;

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <IconFileText className="size-5 text-primary" />
        <h1 className="text-xl font-semibold">Logs</h1>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Ao vivo</span>
          <Switch checked={live} onCheckedChange={setLive} />
        </div>
      </div>

      {live ? (
        <LiveTail />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <TimeRangePicker value={range} onChange={setRange} />
            <Button onClick={runQuery} disabled={isFetching}>
              <IconPlayerPlay className="size-3.5" />
              Run query
            </Button>
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-2">
            <Textarea
              spellCheck={false}
              rows={3}
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runQuery();
              }}
              placeholder={DEFAULT_QUERY}
              className="resize-y font-mono"
            />
            <p className="text-xs text-muted-foreground">{QUERY_HELP}</p>
          </div>

          {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

          {discoveredFields.size > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">campos descobertos:</span>
              {Array.from(discoveredFields)
                .sort()
                .map((f) => (
                  <button
                    key={f}
                    onClick={() => insertField(f)}
                    title={`adicionar "${f}" em fields`}
                    className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {f}
                  </button>
                ))}
            </div>
          )}

          <div className="text-sm text-muted-foreground">
            {data?.total ?? 0} registros {isFetching && "· atualizando…"}
          </div>

          {data && data.rows.length > 0 && (
            <LogsHistogram rows={data.rows as { ts: number }[]} from={applied.range.from} to={applied.range.to} />
          )}

          <div className="flex-1 overflow-auto rounded-lg border">
            <LogsTable columns={columns} rows={(data?.rows ?? []) as LogRow[]} />
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              página {page} / {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                anterior
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                próxima
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Modo "Ao vivo": tail contínuo via SSE, sem paginação (não é busca, é feed). ──
function LiveTail() {
  const [lines, setLines] = useState<string[]>([]);
  const { data } = useQuery({ queryKey: ["logs-recent"], queryFn: () => logsApi.recent(200) });

  useEffect(() => {
    if (data) setLines(data.lines);
  }, [data]);

  useSse<string>("/api/logs/stream", (eventName, raw) => {
    if (eventName !== "log") return;
    setLines((prev) => [...prev.slice(-1000), raw]);
  });

  return (
    <div className="flex-1 overflow-auto rounded-lg border bg-muted/20 p-3 font-mono text-xs">
      {lines
        .slice()
        .reverse()
        .map((line, i) => (
          <div key={i} className="border-b border-border/50 py-1 last:border-0">
            {line}
          </div>
        ))}
      {lines.length === 0 && <p className="text-muted-foreground">Aguardando logs…</p>}
    </div>
  );
}
