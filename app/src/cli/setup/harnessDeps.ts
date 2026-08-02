// Catálogo + instalação das dependências de harness usadas pelo setup
// (passo imediatamente ANTES da detecção). Claude Code / Codex usam adapters
// ACP do Zed; Cursor / Copilot / Goose são CLIs nativos (ou ACP nativo no
// caso do Goose); Hermes é gateway HTTP — não tem adapter ACP.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { bootstrap } from "../../config/bootstrap";
import type { HarnessId } from "../../agent/harness/types";

const execFileAsync = promisify(execFile);

export type HarnessDepKind = "acp-adapter" | "native-cli" | "http-gateway";

export interface HarnessDepSpec {
  id: HarnessId;
  label: string;
  kind: HarnessDepKind;
  /** O que o adapter spawna / sonda (ex.: claude-code-acp, cursor-agent). */
  requiredBin: string;
  /** CLI “de verdade” por baixo do ACP (só pra adapters). */
  underlyingCli?: string;
  /** Pacote npm que publica o requiredBin (se instalável via npm). */
  npmPackage?: string;
  /** Comando de instalação (shell) quando não for npm — rodar com confirmação. */
  installShell?: { cmd: string; args: string[]; label: string };
  /** Só documentação / ação manual (Hermes). */
  manualHint?: string;
  docsUrl?: string;
}

/** Ordem de apresentação no setup — os que o usuário pediu + goose. */
export const HARNESS_DEP_SPECS: HarnessDepSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "acp-adapter",
    requiredBin: "claude-code-acp",
    underlyingCli: "claude",
    npmPackage: "@zed-industries/claude-code-acp",
    docsUrl: "https://www.npmjs.com/package/@zed-industries/claude-code-acp",
  },
  {
    id: "codex",
    label: "Codex",
    kind: "acp-adapter",
    requiredBin: "codex-acp",
    underlyingCli: "codex",
    // Pacote legado ainda publica o bin `codex-acp`; o novo
    // @agentclientprotocol/codex-acp é o destino futuro — preferimos o que
    // o adapter do orchestrator espera pelo nome do binário.
    npmPackage: "@zed-industries/codex-acp",
    docsUrl: "https://github.com/zed-industries/codex-acp",
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "native-cli",
    requiredBin: "cursor-agent",
    installShell:
      process.platform === "win32"
        ? {
            cmd: "powershell",
            args: ["-NoProfile", "-Command", "irm 'https://cursor.com/install?win32=true' | iex"],
            label: "instalador oficial Cursor CLI (PowerShell)",
          }
        : {
            cmd: "bash",
            args: ["-lc", "curl -fsS https://cursor.com/install | bash"],
            label: "instalador oficial Cursor CLI (curl | bash)",
          },
    docsUrl: "https://cursor.com/docs/cli/installation",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    kind: "native-cli",
    requiredBin: "copilot",
    npmPackage: "@github/copilot",
    docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  },
  {
    id: "hermes",
    label: "Hermes",
    kind: "http-gateway",
    requiredBin: "hermes",
    manualHint:
      "Hermes não usa adapter ACP — é um gateway HTTP. Instale o Hermes Agent na máquina/VM e aponte HERMES_*_URL na config (docs/hermes-setup.md).",
    docsUrl: "https://github.com/NousResearch/hermes-agent",
  },
  {
    id: "goose",
    label: "Goose",
    kind: "native-cli",
    requiredBin: "goose",
    installShell: {
      cmd: "bash",
      args: ["-lc", "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash"],
      label: "instalador oficial Goose CLI",
    },
    docsUrl: "https://block.github.io/goose/docs/getting-started/installation",
  },
];

export function harnessBinDir(): string {
  return join(bootstrap.yaoeHome, "harness", "bin");
}

export function harnessNpmPrefix(): string {
  return join(bootstrap.yaoeHome, "harness");
}

const PATH_SEP = process.platform === "win32" ? ";" : ":";

/** Dirs onde CLIs de harness costumam viver (daemon/launchd não herdam o PATH do shell). */
export function harnessPathCandidates(): string[] {
  const home = homedir();
  const dirs = [
    harnessBinDir(),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  if (process.platform === "win32") {
    dirs.push(join(home, "AppData", "Local", "Programs", "cursor-agent"));
  }
  return dirs;
}

/** Garante bins do orchestrator + ~/.local/bin (e afins) no PATH deste processo. */
export function ensureHarnessBinOnPath(): void {
  const binDir = harnessBinDir();
  mkdirSync(binDir, { recursive: true });
  const parts = new Set((process.env.PATH ?? "").split(PATH_SEP).filter(Boolean));
  const prepend: string[] = [];
  for (const dir of harnessPathCandidates()) {
    if (!dir || parts.has(dir)) continue;
    if (dir === binDir || existsSync(dir)) {
      prepend.push(dir);
      parts.add(dir);
    }
  }
  if (prepend.length > 0) {
    process.env.PATH = `${prepend.join(PATH_SEP)}${PATH_SEP}${process.env.PATH ?? ""}`;
  }
}

/**
 * Resolve o binário de harness pra caminho absoluto.
 * Daemon/launchd/systemd frequentemente sobem com PATH mínimo (`/usr/bin:/bin`)
 * — spawn por nome (`cursor-agent`) falha com ENOENT mesmo com o CLI em ~/.local/bin.
 */
export function resolveHarnessBin(bin: string): string {
  if (!bin) return bin;
  if (bin.includes("/") || bin.includes("\\")) return bin;
  ensureHarnessBinOnPath();
  const fromWhich = typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which(bin) : null;
  if (fromWhich) return fromWhich;
  for (const dir of harnessPathCandidates()) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return bin;
}

/** Garante PATH (e HOME) no env passado ao Bun.spawn — env custom substitui o do processo. */
export function withHarnessSpawnEnv(env: Record<string, string>): Record<string, string> {
  ensureHarnessBinOnPath();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  out.PATH = process.env.PATH ?? out.PATH ?? "";
  if (!out.HOME && process.env.HOME) out.HOME = process.env.HOME;
  if (!out.HOME) out.HOME = homedir();
  return out;
}

export async function whichBin(bin: string): Promise<string | null> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(cmd, [bin]);
    return stdout.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export interface HarnessDepStatus {
  spec: HarnessDepSpec;
  requiredOk: boolean;
  requiredPath: string | null;
  underlyingOk: boolean | null;
  underlyingPath: string | null;
  /** Pode oferecer instalação automática neste passo. */
  canAutoInstall: boolean;
}

export async function probeHarnessDep(spec: HarnessDepSpec): Promise<HarnessDepStatus> {
  const requiredPath = await whichBin(spec.requiredBin);
  const underlyingPath = spec.underlyingCli ? await whichBin(spec.underlyingCli) : null;
  return {
    spec,
    requiredOk: Boolean(requiredPath),
    requiredPath,
    underlyingOk: spec.underlyingCli ? Boolean(underlyingPath) : null,
    underlyingPath,
    canAutoInstall: Boolean(spec.npmPackage || spec.installShell),
  };
}

function linkNpmBin(npmPrefix: string, binName: string): void {
  const binDir = harnessBinDir();
  mkdirSync(binDir, { recursive: true });
  const src = join(npmPrefix, "node_modules", ".bin", binName);
  const dest = join(binDir, binName);
  if (!existsSync(src)) {
    throw new Error(`npm instalou o pacote mas não gerou o bin ${binName} em ${src}`);
  }
  try {
    unlinkSync(dest);
  } catch {
    /* não existia */
  }
  if (process.platform === "win32") {
    // No Windows o .bin costuma ser .cmd — copiamos o nome esperado via symlink se possível.
    symlinkSync(src, dest);
  } else {
    symlinkSync(src, dest);
    chmodSync(dest, 0o755);
  }
}

async function runNpmInstall(pkg: string): Promise<void> {
  const npm = (await whichBin("npm")) ?? (await whichBin("bun"));
  if (!npm) throw new Error("nem npm nem bun no PATH — necessário pra instalar pacotes ACP/CLI");

  const prefix = harnessNpmPrefix();
  mkdirSync(prefix, { recursive: true });

  if (npm.endsWith("bun") || npm.includes("/bun")) {
    // bun add --cwd <prefix> <pkg> — equivalente a npm --prefix
    await execFileAsync(npm, ["add", "--cwd", prefix, pkg], { env: process.env });
  } else {
    await execFileAsync(npm, ["install", "--prefix", prefix, pkg], { env: process.env });
  }
}

async function runShellInstall(spec: NonNullable<HarnessDepSpec["installShell"]>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { stdio: "inherit", env: process.env, shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${spec.label} saiu com código ${code ?? "?"}`));
    });
  });
}

export async function installHarnessDep(status: HarnessDepStatus): Promise<{ ok: boolean; detail: string }> {
  const { spec } = status;
  ensureHarnessBinOnPath();

  if (spec.kind === "acp-adapter" && spec.underlyingCli && !status.underlyingOk) {
    return {
      ok: false,
      detail: `CLI base "${spec.underlyingCli}" não está no PATH — instale ${spec.label} primeiro, depois o adapter ACP.`,
    };
  }

  try {
    if (spec.npmPackage) {
      console.log(`   → npm/bun install ${spec.npmPackage} em ${harnessNpmPrefix()}`);
      await runNpmInstall(spec.npmPackage);
      linkNpmBin(harnessNpmPrefix(), spec.requiredBin);
      ensureHarnessBinOnPath();
      const path = await whichBin(spec.requiredBin);
      if (!path) {
        return { ok: false, detail: `instalado mas "${spec.requiredBin}" ainda não resolve no PATH` };
      }
      return { ok: true, detail: path };
    }

    if (spec.installShell) {
      console.log(`   → ${spec.installShell.label}`);
      await runShellInstall(spec.installShell);
      ensureHarnessBinOnPath();
      const path = await whichBin(spec.requiredBin);
      if (!path) {
        return {
          ok: false,
          detail: `instalador rodou, mas "${spec.requiredBin}" não está no PATH — abra um novo terminal ou adicione ~/.local/bin`,
        };
      }
      return { ok: true, detail: path };
    }

    return { ok: false, detail: spec.manualHint ?? "instalação automática não disponível" };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

export function kindLabel(kind: HarnessDepKind): string {
  switch (kind) {
    case "acp-adapter":
      return "adapter ACP";
    case "native-cli":
      return "CLI nativo";
    case "http-gateway":
      return "gateway HTTP";
  }
}
