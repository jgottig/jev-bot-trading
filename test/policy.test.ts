import { describe, expect, it } from "vitest";
import { decidePlan, sizeFractionFor } from "../src/brain/policy.js";
import type { DecisionState } from "../src/brain/features.js";
import type { JevVerdict } from "../src/brain/jev.js";
import { loadConfig, type Config } from "../src/config.js";

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig({ MODE: "paper", ...over } as NodeJS.ProcessEnv);
}

/** Veredicto de compra fuerte: todas las compuertas deberian abrirse. */
function bullish(over: Partial<JevVerdict> = {}): JevVerdict {
  return {
    action: "buy",
    actionProbabilities: { buy: 0.8, sell: 0.1, hold: 0.1 },
    actionConfidence: 0.8,
    conviction: 3.5,
    convictionConfidence: 0.8,
    regime: "trending_up",
    regimeConfidence: 0.8,
    downsideRisk: 0.1,
    exitNow: 0.05,
    model: "jev-test",
    latencyMs: 10,
    ...over,
  };
}

function state(over: { open?: boolean; spreadBps?: number } = {}): DecisionState {
  return {
    market: {
      pair: "XBTUSD",
      timeframe: "15m",
      as_of: new Date().toISOString(),
      price: {
        last: 50000,
        spread_bps: over.spreadBps ?? 4,
        change_1_candle_pct: 0.1,
        change_4_candles_pct: 0.4,
        change_24_candles_pct: 1.2,
      },
      trend: { ema_fast: 50100, ema_slow: 49900, ema_gap_pct: 0.4, price_vs_ema_slow_pct: 0.2, ema_slow_slope_pct: 0.3 },
      momentum: { rsi_14: 58, macd_histogram_pct: 0.05, macd_histogram_rising: true },
      volatility: { atr_pct: 1.2, bollinger_width_pct: 2.5, realized_vol_annualized_pct: 45 },
      volume: { z_score: 0.8 },
      levels: { distance_to_recent_high_pct: -1.5, distance_to_recent_low_pct: 4.2 },
      recent_candles: [],
      costs: { round_trip_cost_pct: 0.84, atr_to_cost_ratio: 1.43 },
    },
    portfolio: {
      has_open_position: over.open ?? false,
      position_quantity: over.open ? 0.01 : 0,
      entry_price: over.open ? 49500 : null,
      unrealized_pnl_pct: over.open ? 1.01 : null,
      hours_in_position: over.open ? 3 : null,
      distance_to_stop_pct: over.open ? -2 : null,
      distance_to_target_pct: over.open ? 3 : null,
      breakeven_price: over.open ? 49898 : null,
      net_pnl_if_closed_now_pct: over.open ? 0.2 : null,
      cash_usd: 1000,
      equity_usd: 1000,
      exposure_pct: 0,
    },
    session: {
      trades_today: 0,
      realized_pnl_today_pct: 0,
      consecutive_losses: 0,
      minutes_since_last_trade: null,
      drawdown_from_peak_pct: 0,
    },
  };
}

describe("decidePlan sin posicion abierta", () => {
  it("abre cuando todas las compuertas dan verde", () => {
    const plan = decidePlan(state(), bullish(), cfg());
    expect(plan.kind).toBe("open");
    expect(plan.sizeFraction).toBeGreaterThan(0);
    expect(plan.gates.every((g) => g.passed)).toBe(true);
  });

  it("no abre si la accion elegida no es comprar", () => {
    const plan = decidePlan(state(), bullish({ action: "hold" }), cfg());
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/action_is_buy/);
  });

  it("no abre si la probabilidad de compra no llega al umbral", () => {
    const v = bullish({ actionProbabilities: { buy: 0.5, sell: 0.2, hold: 0.3 } });
    const plan = decidePlan(state(), v, cfg({ MIN_BUY_PROBABILITY: "0.6" }));
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/buy_probability/);
  });

  it("no abre con confianza insuficiente aunque la probabilidad sea alta", () => {
    const plan = decidePlan(state(), bullish({ actionConfidence: 0.3 }), cfg({ MIN_CONFIDENCE: "0.55" }));
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/confidence/);
  });

  it("no abre con conviccion por debajo del minimo", () => {
    const plan = decidePlan(state(), bullish({ conviction: 1 }), cfg({ MIN_CONVICTION: "2" }));
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/conviction/);
  });

  it("no abre si el propio modelo reporta riesgo de caida alto", () => {
    const plan = decidePlan(state(), bullish({ downsideRisk: 0.9 }), cfg({ MAX_RISK_PROBABILITY: "0.5" }));
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/downside_risk/);
  });

  it("no compra en tendencia bajista, por mas convencido que este el modelo", () => {
    const plan = decidePlan(state(), bullish({ regime: "trending_down", conviction: 4 }), cfg());
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/regime/);
  });

  it("no opera con el spread demasiado abierto", () => {
    const plan = decidePlan(state({ spreadBps: 100 }), bullish(), cfg({ MAX_SPREAD_BPS: "20" }));
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/spread/);
  });

  it("no abre nada con ALLOW_ENTRIES apagado, aunque la senal sea perfecta", () => {
    const plan = decidePlan(state(), bullish({ conviction: 4 }), cfg({ ALLOW_ENTRIES: "false" }));
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/entries_enabled/);
  });

  it("deja registradas todas las compuertas evaluadas, pasen o no", () => {
    const plan = decidePlan(state(), bullish({ action: "hold" }), cfg());
    expect(plan.gates.length).toBeGreaterThanOrEqual(8);
    for (const g of plan.gates) expect(g.detail).toBeTruthy();
  });
});

describe("decidePlan con posicion abierta", () => {
  it("cierra cuando la probabilidad de salida supera el umbral", () => {
    const plan = decidePlan(state({ open: true }), bullish({ exitNow: 0.9 }), cfg({ EXIT_PROBABILITY: "0.65" }));
    expect(plan.kind).toBe("close");
  });

  it("cierra ante una senal de venta clara", () => {
    const v = bullish({ action: "sell", actionProbabilities: { buy: 0.1, sell: 0.8, hold: 0.1 } });
    expect(decidePlan(state({ open: true }), v, cfg()).kind).toBe("close");
  });

  it("deja correr la posicion si no hay senal de salida", () => {
    const plan = decidePlan(state({ open: true }), bullish(), cfg());
    expect(plan.kind).toBe("none");
    expect(plan.reason).toMatch(/dejamos correr/);
  });

  it("nunca abre una segunda posicion sobre una ya abierta", () => {
    const plan = decidePlan(state({ open: true }), bullish({ conviction: 4 }), cfg());
    expect(plan.kind).not.toBe("open");
  });
});

describe("sizeFractionFor", () => {
  it("crece con la conviccion", () => {
    const c = cfg({ MIN_CONVICTION: "2" });
    const low = sizeFractionFor(bullish({ conviction: 2 }), c);
    const high = sizeFractionFor(bullish({ conviction: 4 }), c);
    expect(high).toBeGreaterThan(low);
  });

  it("reduce a la mitad en regimen de alta volatilidad", () => {
    const c = cfg();
    const normal = sizeFractionFor(bullish({ regime: "trending_up" }), c);
    const wild = sizeFractionFor(bullish({ regime: "high_volatility" }), c);
    expect(wild).toBeCloseTo(normal / 2, 6);
  });

  it("descuenta el riesgo de caida que reporta el modelo", () => {
    const c = cfg({ MAX_RISK_PROBABILITY: "1" });
    const safe = sizeFractionFor(bullish({ downsideRisk: 0 }), c);
    const risky = sizeFractionFor(bullish({ downsideRisk: 0.8 }), c);
    expect(risky).toBeLessThan(safe);
  });

  it("siempre queda entre 0 y 1", () => {
    const c = cfg();
    for (const conviction of [0, 1, 2, 3, 4]) {
      for (const downsideRisk of [0, 0.5, 1]) {
        const f = sizeFractionFor(bullish({ conviction, downsideRisk }), c);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
  });
});
