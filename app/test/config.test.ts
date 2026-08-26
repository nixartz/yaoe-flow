// §9.3: precedência ENV > banco > default, hot-reload via getters do config,
// validações de escrita e bloqueio de campos ENV/bootstrap/não-editáveis.
import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import {
  resolveSetting,
  setSetting,
  resetSetting,
  invalidateSettingsCache,
  SettingWriteError,
} from "../src/config/service";

afterEach(() => {
  delete process.env.MAX_DEV_WORKERS;
  delete process.env.MAX_WORKERS;
  delete process.env.IGNORE_FOOTPRINT_LOCKS;
  delete process.env.IGNORE_BLOCKING_ISSUES;
  invalidateSettingsCache();
  try {
    resetSetting("MAX_DEV_WORKERS", null);
    resetSetting("TICK_INTERVAL_MS", null);
    resetSetting("LINEAR_API_KEY", null);
    resetSetting("IGNORE_FOOTPRINT_LOCKS", null);
    resetSetting("IGNORE_BLOCKING_ISSUES", null);
  } catch {
    /* sem linha no banco — ok */
  }
});

describe("config service (ENV > banco > default)", () => {
  test("sem ENV nem banco → default", () => {
    const r = resolveSetting("MAX_DEV_WORKERS");
    expect(r.source).toBe("default");
    expect(r.raw).toBe("1");
    expect(config.capacity.maxDevWorkers).toBe(1);
  });

  test("IGNORE_FOOTPRINT_LOCKS / IGNORE_BLOCKING_ISSUES default false and are hot", () => {
    expect(config.ignoreFootprintLocks).toBe(false);
    expect(config.ignoreBlockingIssues).toBe(false);
    setSetting("IGNORE_FOOTPRINT_LOCKS", "true", null);
    setSetting("IGNORE_BLOCKING_ISSUES", "true", null);
    expect(config.ignoreFootprintLocks).toBe(true);
    expect(config.ignoreBlockingIssues).toBe(true);
    resetSetting("IGNORE_FOOTPRINT_LOCKS", null);
    expect(config.ignoreFootprintLocks).toBe(false);
    expect(config.ignoreBlockingIssues).toBe(true);
  });

  test("valor no banco vence o default e vale IMEDIATAMENTE no getter (hot)", () => {
    setSetting("MAX_DEV_WORKERS", "5", null);
    expect(resolveSetting("MAX_DEV_WORKERS").source).toBe("db");
    expect(config.capacity.maxDevWorkers).toBe(5);
  });

  test("ENV setada vence o banco", () => {
    setSetting("MAX_DEV_WORKERS", "5", null);
    process.env.MAX_DEV_WORKERS = "7";
    invalidateSettingsCache();
    const r = resolveSetting("MAX_DEV_WORKERS");
    expect(r.source).toBe("env");
    expect(config.capacity.maxDevWorkers).toBe(7);
  });


  test("remover a ENV volta pro último valor do banco (critério §5.8)", () => {
    setSetting("MAX_DEV_WORKERS", "5", null);
    process.env.MAX_DEV_WORKERS = "7";
    invalidateSettingsCache();
    expect(config.capacity.maxDevWorkers).toBe(7);
    delete process.env.MAX_DEV_WORKERS;
    invalidateSettingsCache();
    expect(config.capacity.maxDevWorkers).toBe(5);
    expect(resolveSetting("MAX_DEV_WORKERS").source).toBe("db");
  });

  test("escrita bloqueada quando a ENV está setada", () => {
    process.env.MAX_DEV_WORKERS = "7";
    expect(() => setSetting("MAX_DEV_WORKERS", "3", null)).toThrow(SettingWriteError);
  });

  test("validação de tipo e regra específica", () => {
    expect(() => setSetting("MAX_DEV_WORKERS", "banana", null)).toThrow(SettingWriteError);
    expect(() => setSetting("MAX_DEV_WORKERS", "-1", null)).toThrow(SettingWriteError);
    expect(() => setSetting("TICK_INTERVAL_MS", "500", null)).toThrow(/1000/);
    expect(() => setSetting("ORCHESTRATOR_ENABLED", "talvez", null)).toThrow(SettingWriteError);
  });

  test("bootstrap e escopo agent não são editáveis; harness passou a ser (Fase 2, §7.4)", () => {
    expect(() => setSetting("HOST", "0.0.0.0", null)).toThrow(SettingWriteError);
    expect(() => setSetting("HERMES_PMO_MODEL", "x", null)).toThrow(SettingWriteError);
    expect(() => setSetting("GOOSE_BIN", "/usr/bin/goose", null)).not.toThrow();
    resetSetting("GOOSE_BIN", null);
  });

  test("segredo gravado sai cifrado no banco e resolve em claro", async () => {
    setSetting("LINEAR_API_KEY", "lin_api_secreta_999", null);
    const { appDb } = await import("../src/db");
    const row = appDb()
      .sqlite.query(`SELECT value FROM settings WHERE key = 'LINEAR_API_KEY'`)
      .get() as { value: string };
    expect(row.value.startsWith("enc:v1:")).toBe(true);
    expect(row.value).not.toContain("lin_api_secreta_999");
    expect(config.linear.apiKey).toBe("lin_api_secreta_999");
  });

  test("reset remove a linha do banco e volta pro default", () => {
    setSetting("MAX_DEV_WORKERS", "9", null);
    expect(config.capacity.maxDevWorkers).toBe(9);
    resetSetting("MAX_DEV_WORKERS", null);
    expect(resolveSetting("MAX_DEV_WORKERS").source).toBe("default");
    expect(config.capacity.maxDevWorkers).toBe(1);
  });
});
