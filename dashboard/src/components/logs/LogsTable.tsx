import { Fragment, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

// Uma linha de log_lines vinda do motor de query genérico (dashboard/query.ts).
// `id`/`fields_json` sempre vêm (Logs.tsx sempre os inclui em `spec.fields`);
// as demais chaves são as colunas pedidas — reais (ts/level/feature/msg) ou
// "virtuais" (json_extract de dentro de fields_json), já resolvidas pelo
// backend — pro frontend não há diferença, é só ler `row[col]`.
export interface LogRow {
  id: number;
  fields_json: string;
  [key: string]: unknown;
}

const LEVEL_VARIANT: Record<string, "default" | "secondary" | "warning" | "destructive"> = {
  trace: "secondary",
  debug: "secondary",
  info: "default",
  warn: "warning",
  error: "destructive",
  fatal: "destructive",
};

function CellValue({ column, value }: { column: string; value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">–</span>;
  if (column === "ts") return <span className="whitespace-nowrap">{formatDateTime(Number(value))}</span>;
  if (column === "level") {
    const v = String(value).toLowerCase();
    return <Badge variant={LEVEL_VARIANT[v] ?? "outline"}>{v}</Badge>;
  }
  if (typeof value === "object") return <span className="font-mono text-xs">{JSON.stringify(value)}</span>;
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

export function LogsTable({ columns, rows }: { columns: string[]; rows: LogRow[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead key={col} className="whitespace-nowrap">
              {col}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={columns.length || 1} className="text-center text-sm text-muted-foreground">
              Sem resultados para esta busca.
            </TableCell>
          </TableRow>
        )}
        {rows.map((row) => (
          <Fragment key={row.id}>
            <TableRow
              className="cursor-pointer"
              onClick={() => setExpanded((e) => (e === row.id ? null : row.id))}
            >
              {columns.map((col) => (
                <TableCell key={col}>
                  <CellValue column={col} value={row[col]} />
                </TableCell>
              ))}
            </TableRow>
            {expanded === row.id && (
              <TableRow>
                <TableCell colSpan={columns.length || 1} className="bg-muted/30">
                  <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <IconChevronDown className="size-3" />
                    JSON completo
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(row.fields_json || "{}"), null, 2);
                      } catch {
                        return row.fields_json;
                      }
                    })()}
                  </pre>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
