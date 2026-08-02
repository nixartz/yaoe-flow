#!/usr/bin/env bun
// generate-project-map.ts
// Varre um repositório e gera PROJECT_MAP.md — o inventário vivo que os agents
// leem ANTES de implementar (read-before-write) e usam no planning pass do
// Orquestrador. Roda em repos Node/Bun.
//
// Uso:
//   bun generate-project-map.ts [rootDir] [--out PROJECT_MAP.md]
//   (default rootDir = "src")
//
// Ideal rodar como step de CI (a cada merge na main) para nunca ficar velho.

import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, extname } from "node:path";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--")) ?? "src";
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : "PROJECT_MAP.md";

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);
const IGNORE_DIR = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", ".cache",
]);

interface Entry {
  path: string;
  exports: string[];
}

function walk(dir: string, acc: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return acc; // dir não existe
  }
  for (const name of names) {
    if (IGNORE_DIR.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (CODE_EXT.has(extname(name))) acc.push(full);
  }
  return acc;
}

function extractExports(src: string): string[] {
  const names = new Set<string>();
  const single = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /export\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/g,
    /export\s+class\s+([A-Za-z0-9_]+)/g,
    /export\s+(?:type|interface)\s+([A-Za-z0-9_]+)/g,
  ];
  for (const re of single) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  // export { a, b as c }
  const brace = /export\s*\{\s*([^}]+)\}/g;
  let bm: RegExpExecArray | null;
  while ((bm = brace.exec(src))) {
    for (const part of bm[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (n && n !== "default") names.add(n);
    }
  }
  if (/export\s+default(?!\s+(?:async\s+)?function)/.test(src)) names.add("(default)");
  return [...names];
}

function categorize(path: string): string {
  const p = path.toLowerCase().replace(/\\/g, "/");
  if (/(^|\/)(app|pages|routes)\//.test(p)) return "Páginas / Rotas";
  if (/\.service\./.test(p) || /(^|\/)services\//.test(p)) return "Services";
  if (/(^|\/)api\//.test(p) || /\.route\./.test(p)) return "API / Endpoints";
  if (/(^|\/)hooks\//.test(p) || /\/use[a-z0-9_]+\.(t|j)sx?$/.test(p)) return "Hooks";
  if (/(^|\/)(components|ui)\//.test(p) || extname(path) === ".tsx") return "Componentes";
  if (/(^|\/)(lib|utils|helpers)\//.test(p)) return "Lib / Utils";
  if (/(^|\/)(types|models|schema|schemas)\//.test(p)) return "Tipos / Models";
  return "Outros";
}

// ── main ──
const files = walk(root);
const byCat = new Map<string, Entry[]>();
for (const f of files) {
  const exports = extractExports(readFileSync(f, "utf8"));
  const cat = categorize(f);
  if (!byCat.has(cat)) byCat.set(cat, []);
  byCat.get(cat)!.push({ path: relative(process.cwd(), f), exports });
}

const order = [
  "Páginas / Rotas", "Componentes", "Hooks", "Services",
  "API / Endpoints", "Lib / Utils", "Tipos / Models", "Outros",
];
const cats = [...byCat.keys()].sort(
  (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)
);

let md = `# PROJECT_MAP\n\n`;
md += `> Inventário auto-gerado — NÃO edite à mão; rode o gerador.\n`;
md += `> Gerado em ${new Date().toISOString()} · raiz \`${root}\` · ${files.length} arquivos.\n\n`;
md += `Os agents leem este arquivo antes de implementar (read-before-write) e no `;
md += `planning pass. Use-o para descobrir o que JÁ existe antes de criar algo novo.\n\n`;

for (const cat of cats) {
  const entries = byCat.get(cat)!.sort((a, b) => a.path.localeCompare(b.path));
  md += `## ${cat} (${entries.length})\n\n`;
  for (const e of entries) {
    const ex = e.exports.length ? ` — ${e.exports.join(", ")}` : "";
    md += `- \`${e.path}\`${ex}\n`;
  }
  md += `\n`;
}

writeFileSync(outFile, md);
console.log(`PROJECT_MAP gerado: ${outFile} (${files.length} arquivos, ${cats.length} categorias)`);
