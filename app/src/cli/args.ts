// Parsing de argv da CLI `orchestrator` (docs/daemon-binary.md §4). Sem
// dependência externa (citty/yargs): os subcomandos e flags são poucos e
// estáveis — um parser manual mantém o binário compilado pequeno e sem
// supply-chain extra.
export interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[arg.slice(2)] = next;
        i++;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { command, flags, positionals };
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
