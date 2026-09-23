import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { assessEdge, breakevenPrice, jevCallCostUsd, roundTripCost } from "../src/risk/costs.js";
import type { Quote } from "../src/types.js";

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig({ MODE: "paper", ...over } as NodeJS.ProcessEnv);
}

const quote: Quote = { bid: 50000, ask: 50010, last: 50005, time: 0 };

describe("roundTripCost", () => {
  it("suma comision de ida, de vuelta, spread y slippage", () => {
    const c = cfg({ FEE_RATE: "0.004", PAPER_SLIPPAGE_BPS: "5" });
    const costs = roundTripCost(quote, c);

    expect(costs.entryFeeBps).toBe(40);
    expect(costs.exitFeeBps).toBe(40);
    expect(costs.slippageBps).toBe(10);
    // spread = (50010-50000)/50005 * 10000 ~= 2 bps
    expect(costs.spreadBps).toBeCloseTo(2, 1);
    expect(costs.roundTripBps).toBeCloseTo(92, 1);
  });

  it("con el arancel base de Kraken la vuelta cuesta mas del 0.8%", () => {
    // El numero que decide si esta estrategia tiene sentido.
    const costs = roundTripCost(quote, cfg({ FEE_RATE: "0.004" }));
    expect(costs.roundTripBps / 100).toBeGreaterThan(0.8);
  });

  it("crece cuando se abre el spread", () => {
    const wide: Quote = { bid: 49800, ask: 50200, last: 50000, time: 0 };
    expect(roundTripCost(wide, cfg()).roundTripBps).toBeGreaterThan(
      roundTripCost(quote, cfg()).roundTripBps,
    );
  });
});

describe("breakevenPrice", () => {
  it("queda siempre por encima del precio de entrada", () => {
    expect(breakevenPrice(50000, cfg({ FEE_RATE: "0.004" }))).toBeGreaterThan(50000);
  });

  it("vender ahi deja el capital intacto, descontadas ambas comisiones", () => {
    const c = cfg({ FEE_RATE: "0.004" });
    const entry = 50000;
    const qty = 0.01;
    const be = breakevenPrice(entry, c);

    // Lo gastado al comprar, comision incluida.
    const spent = entry * qty * (1 + c.FEE_RATE);
    // Lo recibido al vender en el punto de equilibrio, neto de comision.
    const received = be * qty * (1 - c.FEE_RATE);
    expect(received).toBeCloseTo(spent, 6);
  });

  it("es igual al precio de entrada si no hubiera comisiones", () => {
    expect(breakevenPrice(50000, cfg({ FEE_RATE: "0" }))).toBe(50000);
  });
});

describe("jevCallCostUsd", () => {
  it("cobra solo los tokens de entrada, a USD 0.042 por millon", () => {
    expect(jevCallCostUsd(1_000_000)).toBeCloseTo(0.042, 10);
    expect(jevCallCostUsd(1100)).toBeCloseTo(0.0000462, 12);
  });

  it("un mes de ciclos cada 5 minutos cuesta menos que una sola operacion", () => {
    // ~1100 tokens por ciclo, 288 ciclos por dia, 30 dias.
    const mesDeModelo = jevCallCostUsd(1100) * 288 * 30;
    // Una sola vuelta sobre 250 USD al 0.40% por lado.
    const unaOperacion = 250 * 0.004 * 2;

    expect(mesDeModelo).toBeLessThan(unaOperacion);
    expect(unaOperacion / mesDeModelo).toBeGreaterThan(4);
  });
});

describe("assessEdge", () => {
  it("aprueba cuando el objetivo cubre el costo con margen", () => {
    const c = cfg({ FEE_RATE: "0.004", MIN_EDGE_MULTIPLE: "1.5" });
    // Objetivo 3% sobre 50010, contra un costo de ~92 bps.
    const edge = assessEdge(50010, 50010 * 1.03, quote, c);

    expect(edge.targetBps).toBeCloseTo(300, 0);
    expect(edge.sufficient).toBe(true);
    expect(edge.netBps).toBeGreaterThan(0);
    expect(edge.edgeMultiple).toBeGreaterThan(1.5);
  });

  it("rechaza cuando el objetivo apenas empata el costo", () => {
    const c = cfg({ FEE_RATE: "0.004", MIN_EDGE_MULTIPLE: "1.5" });
    // Objetivo del 0.9%: supera el costo de 0.92%... apenas, y no le gana.
    const edge = assessEdge(50010, 50010 * 1.009, quote, c);
    expect(edge.sufficient).toBe(false);
  });

  it("rechaza un objetivo que directamente pierde plata", () => {
    const c = cfg({ FEE_RATE: "0.004" });
    const edge = assessEdge(50010, 50010 * 1.005, quote, c);
    expect(edge.netBps).toBeLessThan(0);
    expect(edge.sufficient).toBe(false);
  });

  it("el mismo objetivo pasa o no segun el arancel del exchange", () => {
    const target = 50010 * 1.012;
    const caro = assessEdge(50010, target, quote, cfg({ FEE_RATE: "0.004" }));
    const barato = assessEdge(50010, target, quote, cfg({ FEE_RATE: "0.001" }));

    expect(caro.sufficient).toBe(false);
    expect(barato.sufficient).toBe(true);
  });

  it("exigir mas margen rechaza mas operaciones", () => {
    const target = 50010 * 1.02;
    const laxo = assessEdge(50010, target, quote, cfg({ MIN_EDGE_MULTIPLE: "1" }));
    const estricto = assessEdge(50010, target, quote, cfg({ MIN_EDGE_MULTIPLE: "5" }));

    expect(laxo.sufficient).toBe(true);
    expect(estricto.sufficient).toBe(false);
  });
});
