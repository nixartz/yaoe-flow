// Interactive prompt helpers for the `yaoe-flow setup` wizard. Each call
// creates/closes its own readline interface — avoids a global stdin listener
// fighting the raw mode used by askSecret() (the wizard never asks two
// questions in parallel, so this is safe).
import { createInterface } from "node:readline/promises";

export async function ask(question: string, def?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = def ? ` [${def}]` : "";
    const answer = (await rl.question(`${question}${suffix} `)).trim();
    return answer || def || "";
  } finally {
    rl.close();
  }
}

// Control codes used by askSecret() — via fromCharCode (not literals) so the
// source does not depend on ambiguous escapes.
const KEY_ENTER_LF = String.fromCharCode(10);
const KEY_ENTER_CR = String.fromCharCode(13);
const KEY_EOF = String.fromCharCode(4); // Ctrl-D
const KEY_SIGINT = String.fromCharCode(3); // Ctrl-C
const KEY_DEL = String.fromCharCode(127);
const KEY_BACKSPACE = String.fromCharCode(8);

/** Masked-input question (passwords/API keys) — falls back to plain ask() without a TTY (pipe/CI). */
export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);

  return new Promise((resolvePromise) => {
    process.stdout.write(`${question} `);
    const stdin = process.stdin;
    let input = "";
    const onData = (buf: Buffer) => {
      const char = buf.toString("utf8");
      if (char === KEY_ENTER_LF || char === KEY_ENTER_CR || char === KEY_EOF) {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolvePromise(input);
        return;
      }
      if (char === KEY_SIGINT) {
        process.stdout.write("\n");
        process.exit(1);
      }
      if (char === KEY_DEL || char === KEY_BACKSPACE) {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

export async function confirm(question: string, def = true): Promise<boolean> {
  const suffix = def ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${suffix}`)).trim().toLowerCase();
  if (!answer) return def;
  return answer === "y" || answer === "yes" || answer === "s" || answer === "sim";
}

/** Masks a secret for display in the setup (keeps a short prefix + suffix). */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * If a value is already configured: shows it (masked when secret) and asks
 * whether to change — Enter / "n" keeps it. Without a value: prompts directly.
 */
export async function askOrKeep(
  label: string,
  current: string | undefined | null,
  prompt: () => Promise<string>,
  opts?: { secret?: boolean }
): Promise<string> {
  const filled = (current ?? "").trim();
  if (!filled) return prompt();

  const display = opts?.secret ? maskSecret(filled) : filled;
  console.log(`✅ ${label} already configured: ${display}`);
  if (!(await confirm("Change it? (Enter = keep)", false))) return filled;
  return prompt();
}

export interface ChoiceOption {
  label: string;
  value: string;
}

export async function choose(question: string, options: ChoiceOption[]): Promise<ChoiceOption> {
  console.log(question);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  for (;;) {
    const answer = await ask("Pick a number:");
    const idx = Number(answer) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return options[idx]!;
    console.log("invalid option, try again.");
  }
}

/**
 * If `currentValue` is among the options: shows it and asks whether to switch
 * (Enter = keep). Otherwise, chooses normally.
 */
export async function chooseOrKeep(
  question: string,
  options: ChoiceOption[],
  currentValue: string | undefined | null,
  currentLabel?: string
): Promise<ChoiceOption> {
  const current = currentValue ? options.find((o) => o.value === currentValue) : undefined;
  if (current) {
    console.log(`✅ ${currentLabel ?? question} already configured: ${current.label}`);
    if (!(await confirm("Switch? (Enter = keep)", false))) return current;
  } else if (currentValue && currentLabel) {
    console.log(`⚠️  ${currentLabel} pointed at a value that no longer exists (${currentValue}) — choose again.`);
  }
  return choose(question, options);
}
