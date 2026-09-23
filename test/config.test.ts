import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { MODE: "paper" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("aplica los valores por defecto", () => {
    const cfg = loadConfig(base);
    expect(cfg.MODE).toBe("paper");
    expect(cfg.PAIR).toBe("XBTUSD");
    expect(cfg.CANDLE_INTERVAL_MIN).toBe(15);
    expect(cfg.ALLOW_ENTRIES).toBe(true);
  });

  it("convierte numeros y booleanos escritos como texto", () => {
    const cfg = loadConfig({ ...base, MAX_POSITION_PCT: "0.5", ALLOW_ENTRIES: "false" });
    expect(cfg.MAX_POSITION_PCT).toBe(0.5);
    expect(cfg.ALLOW_ENTRIES).toBe(false);
  });

  it("acepta las grafias habituales de booleano", () => {
    for (const v of ["1", "true", "yes", "si", "on", "TRUE", "Si"]) {
      expect(loadConfig({ ...base, ALLOW_ENTRIES: v }).ALLOW_ENTRIES).toBe(true);
    }
    for (const v of ["0", "false", "no", "off"]) {
      expect(loadConfig({ ...base, ALLOW_ENTRIES: v }).ALLOW_ENTRIES).toBe(false);
    }
  });

  it("rechaza porcentajes fuera del rango 0-1", () => {
    expect(() => loadConfig({ ...base, MAX_POSITION_PCT: "1.5" })).toThrow(/Configuracion invalida/);
  });

  it("rechaza un modo desconocido", () => {
    expect(() => loadConfig({ ...base, MODE: "turbo" })).toThrow(/Configuracion invalida/);
  });

  it("exige que el objetivo este mas lejos que el stop", () => {
    expect(() =>
      loadConfig({ ...base, STOP_ATR_MULT: "3", TAKE_PROFIT_ATR_MULT: "2" }),
    ).toThrow(/debe ser mayor que/);
  });

  it("exige que el riesgo por operacion sea menor que la distancia al stop", () => {
    // Si fueran iguales, el tope de riesgo no limitaria nada. Ver risk/manager.ts.
    expect(() =>
      loadConfig({ ...base, RISK_PER_TRADE_PCT: "0.05", HARD_STOP_PCT: "0.05" }),
    ).toThrow(/nunca llega a limitar/);
  });

  it("exige que el freno diario salte antes que el apagado total", () => {
    expect(() =>
      loadConfig({ ...base, DAILY_LOSS_LIMIT_PCT: "0.2", MAX_DRAWDOWN_PCT: "0.15" }),
    ).toThrow(/tiene que saltar antes/);
  });

  it("no deja operar en vivo sin credenciales de Kraken", () => {
    expect(() => loadConfig({ MODE: "live" })).toThrow(/necesita KRAKEN_API_KEY/);
    expect(() => loadConfig({ MODE: "dryrun" })).toThrow(/necesita KRAKEN_API_KEY/);
  });

  it("acepta modo en vivo con las credenciales completas", () => {
    const cfg = loadConfig({ MODE: "live", KRAKEN_API_KEY: "k", KRAKEN_API_SECRET: "s" });
    expect(cfg.MODE).toBe("live");
  });

  it("no exige credenciales en paper", () => {
    expect(() => loadConfig(base)).not.toThrow();
  });
});
