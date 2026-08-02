// Parsing de argv da CLI `orchestrator` (docs/daemon-binary.md §4).
import { describe, expect, test } from "bun:test";
import { flagBool, flagStr, parseArgs } from "../src/cli/args";

describe("parseArgs", () => {
  test("comando sem flags", () => {
    expect(parseArgs(["version"])).toEqual({ command: "version", flags: {}, positionals: [] });
  });

  test("argv vazio → command undefined", () => {
    expect(parseArgs([])).toEqual({ command: undefined, flags: {}, positionals: [] });
  });

  test("flag booleana curta (-d)", () => {
    expect(parseArgs(["daemon", "-d"])).toEqual({ command: "daemon", flags: { d: true }, positionals: [] });
  });

  test("--flag valor (espaço)", () => {
    const { flags } = parseArgs(["setup", "--config", "/tmp/x.env"]);
    expect(flags.config).toBe("/tmp/x.env");
  });

  test("--flag=valor (igual)", () => {
    const { flags } = parseArgs(["setup", "--config=/tmp/x.env"]);
    expect(flags.config).toBe("/tmp/x.env");
  });

  test("--flag bare vira boolean quando o próximo token é outra flag", () => {
    const { flags } = parseArgs(["setup", "--non-interactive", "--config", "/tmp/x.env"]);
    expect(flags["non-interactive"]).toBe(true);
    expect(flags.config).toBe("/tmp/x.env");
  });

  test("--flag no fim do argv vira boolean", () => {
    expect(parseArgs(["stop", "--force"]).flags.force).toBe(true);
  });

  test("positionals são preservados", () => {
    expect(parseArgs(["doctor", "extra1", "extra2"]).positionals).toEqual(["extra1", "extra2"]);
  });
});

describe("flagBool / flagStr", () => {
  test("flagBool reconhece true literal e string 'true'", () => {
    expect(flagBool({ a: true }, "a")).toBe(true);
    expect(flagBool({ a: "true" }, "a")).toBe(true);
    expect(flagBool({ a: "false" }, "a")).toBe(false);
    expect(flagBool({}, "a")).toBe(false);
  });

  test("flagStr só retorna quando o valor é string", () => {
    expect(flagStr({ a: "x" }, "a")).toBe("x");
    expect(flagStr({ a: true }, "a")).toBeUndefined();
    expect(flagStr({}, "a")).toBeUndefined();
  });
});
