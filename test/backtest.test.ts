import { describe, expect, it } from "vitest";
import { HeuristicBrain } from "../src/brain/heuristic.js";
import { runBacktest } from "../src/backtest/runner.js";
import { loadConfig } from "../src/config.js";
import type { Candle, PairRules } from "../src/types.js";

const rules: PairRules = { priceDecimals: 1, quantityDecimals: 8, minQuantity: 0.0001, minNotional: 5 };

function cfg(over: Record<string, string> = {}) {
  return loadConfig({ MODE: "paper", PAPER_STARTING_CASH: "1000", COOLDOWN_MIN: "0", ...over } as NodeJS.ProcessEnv);
}

/** Serie sintetica reproducible: tendencia + oscilacion + ruido determinista. */
function series(count: number, opts: { start?: number; drift?: number; wave?: number } = {}): Candle[] {
  const start = opts.start ?? 50000;
  const drift = opts.drift ?? 0;
  const wave = opts.wave ?? 0;
  return Array.from({ length: count }, (_, i) => {
    const close = start + drift * i + Math.sin(i / 8) * wave;
    const range = Math.abs(close) * 0.004;
    return {
      time: 1_700_000_000_000 + i * 900_000,
      open: close - range / 4,
      high: close + range,
      low: close - range,
      close,
      volume: 10 + (i % 7),
    };
  });
}

describe("runBacktest", () => {
  it("corre de punta a punta y devuelve metricas coherentes", async () => {
    const result = await runBacktest({
      candles: series(600, { drift: 20, wave: 400 }),
      cfg: cfg(),
      rules,
      brain: new HeuristicBrain(),
    });

    expect(result.candlesEvaluated).toBe(540);
    expect(result.startEquity).toBe(1000);
    expect(result.endEquity).toBeGreaterThan(0);
    expect(result.wins + result.losses).toBe(result.trades.length);
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it("no deja posiciones abiertas al terminar", async () => {
    const result = await runBacktest({
      candles: series(400, { drift: 30, wave: 200 }),
      cfg: cfg(),
      rules,
      brain: new HeuristicBrain(),
    });
    for (const t of result.trades) {
      expect(t.exitTime).toBeGreaterThanOrEqual(t.entryTime);
      expect(t.exitPrice).toBeGreaterThan(0);
    }
  });

  it("cobra comisiones en toda operacion realizada", async () => {
    const result = await runBacktest({
      candles: series(500, { drift: 25, wave: 300 }),
      cfg: cfg({ FEE_RATE: "0.0026" }),
      rules,
      brain: new HeuristicBrain(),
    });
    if (result.trades.length > 0) expect(result.totalFees).toBeGreaterThan(0);
  });

  it("es reproducible: la misma entrada da el mismo resultado", async () => {
    const candles = series(400, { drift: 15, wave: 250 });
    const a = await runBacktest({ candles, cfg: cfg(), rules, brain: new HeuristicBrain() });
    const b = await runBacktest({ candles, cfg: cfg(), rules, brain: new HeuristicBrain() });
    expect(a.endEquity).toBe(b.endEquity);
    expect(a.trades.length).toBe(b.trades.length);
  });

  it("no abre nada con ALLOW_ENTRIES apagado", async () => {
    const result = await runBacktest({
      candles: series(400, { drift: 30, wave: 200 }),
      cfg: cfg({ ALLOW_ENTRIES: "false" }),
      rules,
      brain: new HeuristicBrain(),
    });
    expect(result.trades).toHaveLength(0);
    expect(result.endEquity).toBe(1000);
  });

  it("limita la perdida en un derrumbe sostenido, gracias a los stops", async () => {
    // Caida del 40%: el bot no puede vender en corto, pero sus stops tienen que
    // evitar que acompanie la caida entera.
    const crash = series(500, { drift: -40, wave: 100 });
    const result = await runBacktest({ candles: crash, cfg: cfg(), rules, brain: new HeuristicBrain() });
    expect(result.buyAndHoldPct).toBeLessThan(-20);
    expect(result.returnPct).toBeGreaterThan(result.buyAndHoldPct);
  });

  it("exige suficientes velas para que los indicadores se formen", async () => {
    await expect(
      runBacktest({ candles: series(30), cfg: cfg(), rules, brain: new HeuristicBrain() }),
    ).rejects.toThrow(/Hacen falta mas de/);
  });
});
