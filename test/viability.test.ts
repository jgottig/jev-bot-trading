import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { JEV_ANNUAL_COST_USD, assessCapital } from "../src/risk/viability.js";
import type { PairRules } from "../src/types.js";

const rules: PairRules = { priceDecimals: 1, quantityDecimals: 8, minQuantity: 0.0001, minNotional: 5 };
const PRICE = 50_000;

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig({ MODE: "paper", ...over } as NodeJS.ProcessEnv);
}

describe("assessCapital", () => {
  it("bloquea 30.000 ARS: la posicion no llega al minimo del par", () => {
    // 30.000 ARS a ~1582 por dolar son unos USD 19.
    const r = assessCapital(19, rules, cfg(), PRICE);
    expect(r.level).toBe("blocked");
    expect(r.positionUsd).toBeCloseTo(4.75, 2);
    expect(r.messages.join(" ")).toMatch(/nunca abriria una operacion/);
  });

  it("bloquea tambien por economia: la API cuesta mas que la ganancia posible", () => {
    const r = assessCapital(19, rules, cfg(), PRICE);
    // 15% sobre 19 son 2.85 USD, menos que los 4.85 que cuesta la API al ano.
    expect(r.apiCostAsPctOfGain).toBeGreaterThan(100);
    expect(r.messages.join(" ")).toMatch(/perderia plata aunque acertara/);
  });

  it("calcula el capital minimo para la configuracion dada", () => {
    // minimo del par = 0.0001 BTC x 50.000 = USD 5; MIN_ORDER_USD = 10 manda.
    // Con posiciones del 25%, hacen falta USD 40.
    const r = assessCapital(19, rules, cfg({ MAX_POSITION_PCT: "0.25" }), PRICE);
    expect(r.minPositionUsd).toBe(10);
    expect(r.minCapitalUsd).toBe(40);
  });

  it("avisa cuando el capital alcanza pero deja poco margen", () => {
    const r = assessCapital(100, rules, cfg(), PRICE);
    expect(r.level).toBe("warning");
    expect(r.messages.join(" ")).toMatch(/%/);
  });

  it("aprueba un capital holgado", () => {
    const r = assessCapital(1000, rules, cfg(), PRICE);
    expect(r.level).toBe("ok");
    expect(r.positionUsd).toBe(250);
    expect(r.apiCostAsPctOfGain).toBeLessThan(5);
  });

  it("subir MAX_POSITION_PCT baja el capital minimo pero concentra el riesgo", () => {
    const conservador = assessCapital(50, rules, cfg({ MAX_POSITION_PCT: "0.25" }), PRICE);
    const agresivo = assessCapital(50, rules, cfg({ MAX_POSITION_PCT: "1", RISK_PER_TRADE_PCT: "0.04" }), PRICE);
    expect(agresivo.minCapitalUsd).toBeLessThan(conservador.minCapitalUsd);
    expect(agresivo.positionUsd).toBeGreaterThan(conservador.positionUsd);
  });

  it("tiene en cuenta el minimo en dolares que impone el exchange", () => {
    const exigente: PairRules = { ...rules, minNotional: 50 };
    const r = assessCapital(100, exigente, cfg(), PRICE);
    expect(r.minPositionUsd).toBe(50);
    expect(r.level).toBe("blocked");
  });

  it("el costo anual de la API es el que medimos sobre el payload real", () => {
    expect(JEV_ANNUAL_COST_USD).toBeGreaterThan(4);
    expect(JEV_ANNUAL_COST_USD).toBeLessThan(6);
  });
});
