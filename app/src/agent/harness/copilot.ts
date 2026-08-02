// Adapter GitHub Copilot (§7.2, D6): plano B nativo — CLI `copilot` headless
// com saída JSON. Auth via login GitHub com assinatura (D5) — sem API key
// própria (Copilot não expõe BYOK). Mesma nota de honestidade de cursor.ts: o
// parser de linha é o ponto a ajustar após o smoke test real (§9.2).
import { createNativeStreamJsonAdapter } from "./nativeStreamJson";
import { detectByVersionFlag } from "./acpAdapter";

export const copilotAdapter = createNativeStreamJsonAdapter({
  id: "copilot",
  label: "GitHub Copilot",
  bin: "copilot",
  buildArgs: () => ["--output-format", "json", "-p"],
  buildEnv: (input) => {
    const env = { ...input.env };
    if (!env.LINEAR_API_TOKEN && env.LINEAR_API_KEY) env.LINEAR_API_TOKEN = env.LINEAR_API_KEY;
    if (!env.GITHUB_PERSONAL_ACCESS_TOKEN && env.GITHUB_TOKEN) env.GITHUB_PERSONAL_ACCESS_TOKEN = env.GITHUB_TOKEN;
    return env;
  },
  capabilities: {
    integration: "native",
    modelSelection: "none",
    usageReporting: "none",
    costSource: "subscription",
    sessionResume: false,
    mcp: true,
    kill: true,
  },
  // Copilot loga com o GitHub CLI (gh auth) — reporta "ok" quando GITHUB_TOKEN
  // está presente (proxy honesto; não há comando de "quem estou" documentado
  // publicamente pra sondar aqui sem o binário instalado).
  detect: () =>
    detectByVersionFlag("copilot", {
      authEnvVar: "GITHUB_TOKEN",
      installHint: "npm i -g @github/copilot   (ou: curl -fsSL https://gh.io/copilot-install | bash)",
    }),
  parseLine(line) {
    const type = line.type as string | undefined;
    if (type === "text" || type === "message") {
      return { textDelta: (line.text ?? line.content) as string | undefined };
    }
    if (type === "tool_call") {
      return { toolName: line.name as string | undefined, toolStatus: line.status as string | undefined };
    }
    if (type === "done" || type === "result") {
      return { done: true, sessionId: line.session_id as string | undefined };
    }
    return {};
  },
});
