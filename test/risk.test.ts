import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import {
  checkBreakers,
  checkHardExits,
  computeBuyQuantity,
  initialLevels,
  updateTrailingStop,
} from "../src/risk/manager.js";
import { emptyState, type BotState } from "../src/state/store.js";
import { atr, last } from "../src/indicators/index.js";
import type { Candle, PairRules, Position, Quote } from "../src/types.js";

function lastAtr(cs: Candle[]): number | null {
  return last(atr(cs, 14));
}

function cfg(overrides: Record<string, string> = {}): Config {
  return loadConfig({ MODE: "paper", ...overrides } as NodeJS.ProcessEnv);
}

const rules: PairRules = {
  priceDecimals: 1,
  quantityDecimals: 8,
  minQuantity: 0.0001,
  minNotional: 5,
};

function position(over: Partial<Position> = {}): Position {
  return {
    quantity: 0.01,
    entryPrice: 50000,
    entryTime: Date.now(),
    stopPrice: 49000,
    targetPrice: 52000,
    highWaterPrice: 50000,
    ...over,
  };
}

function quote(bid: number, ask = bid + 10): Quote {
  return { bid, ask, last: (bid + ask) / 2, time: Date.now() };
}

function candles(count: number, price = 50000, range = 500): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: i * 900_000,
    open: price,
    high: price + range / 2,
    low: price - range / 2,
    close: price,
    volume: 10,
  }));
}

describe("checkHardExits", () => {
  it("cierra cuando el bid toca el stop", () => {
    const exit = checkHardExits(position(), quote(48999), cfg());
    expect(exit?.reason).toBe("stop_loss");
  });

  it("distingue el trailing stop del stop inicial", () => {
    // El stop ya subio por encima de la entrada: si salta, fue el trailing.
    const exit = checkHardExits(
      position({ stopPrice: 51000, entryPrice: 50000 }),
      quote(50999),
      cfg(),
    );
    expect(exit?.reason).toBe("trailing_stop");
  });

  it("cierra al alcanzar el objetivo", () => {
    expect(checkHardExits(position(), quote(52001), cfg())?.reason).toBe("take_profit");
  });

  it("cierra por tiempo maximo de sostenimiento", () => {
    const old = position({ entryTime: Date.now() - 100 * 3_600_000 });
    expect(checkHardExits(old, quote(50500), cfg({ MAX_HOLDING_HOURS: "72" }))?.reason).toBe(
      "max_holding_time",
    );
  });

  it("no cierra nada mientras el precio esta entre el stop y el objetivo", () => {
    expect(checkHardExits(position(), quote(50500), cfg())).toBeNull();
  });

  it("evalua el stop contra el bid, que es el precio al que realmente venderiamos", () => {
    // El last esta por encima del stop pero el bid ya lo perforo: hay que salir.
    const q: Quote = { bid: 48999, ask: 49200, last: 49100, time: Date.now() };
    expect(checkHardExits(position(), q, cfg())?.reason).toBe("stop_loss");
  });
});

describe("updateTrailingStop", () => {
  it("sube el stop cuando el precio avanza", () => {
    const updated = updateTrailingStop(position(), quote(55000), cfg({ TRAILING_STOP_PCT: "0.03" }));
    expect(updated.stopPrice).toBeCloseTo(55000 * 0.97, 6);
    expect(updated.highWaterPrice).toBe(55000);
  });

  it("nunca baja el stop, aunque el precio retroceda", () => {
    // Esto es lo que impide que una posicion ganadora se convierta en perdedora.
    const raised = updateTrailingStop(position(), quote(55000), cfg());
    const afterDrop = updateTrailingStop(raised, quote(51000), cfg());
    expect(afterDrop.stopPrice).toBe(raised.stopPrice);
    expect(afterDrop.highWaterPrice).toBe(raised.highWaterPrice);
  });
});

describe("initialLevels", () => {
  it("elige el stop mas cercano entre el del ATR y el piso porcentual", () => {
    const c = cfg({ STOP_ATR_MULT: "2", HARD_STOP_PCT: "0.05" });
    // ATR 250 -> stop por ATR = 49500. Piso 5% -> 47500. Gana el mas cercano.
    expect(initialLevels(50000, 250, c).stopPrice).toBe(49500);
    // ATR 2000 -> stop por ATR = 46000, mas lejos que el piso: gana el piso.
    expect(initialLevels(50000, 2000, c).stopPrice).toBe(47500);
  });

  it("cae al piso porcentual si no hay ATR disponible", () => {
    const levels = initialLevels(50000, null, cfg({ HARD_STOP_PCT: "0.05" }));
    expect(levels.stopPrice).toBe(47500);
    expect(levels.targetPrice).toBeGreaterThan(50000);
  });

  it("siempre deja el objetivo mas lejos que el stop", () => {
    for (const atrValue of [50, 250, 1000, 5000, null]) {
      const l = initialLevels(50000, atrValue, cfg());
      expect(50000 - l.stopPrice).toBeGreaterThan(0);
      expect(l.targetPrice - 50000).toBeGreaterThan(50000 - l.stopPrice);
    }
  });
});

describe("checkBreakers", () => {
  function state(over: Partial<BotState> = {}): BotState {
    return { ...emptyState(1000), ...over };
  }

  it("deja pasar cuando todo esta en orden", () => {
    expect(checkBreakers(state(), 1000, quote(50000), cfg()).blocked).toBe(false);
  });

  it("apaga el bot al superar el drawdown maximo", () => {
    const r = checkBreakers(state({ equityPeak: 1000 }), 800, quote(50000), cfg({ MAX_DRAWDOWN_PCT: "0.15" }));
    expect(r.blocked).toBe(true);
    expect(r.killSwitch).toBe(true);
  });

  it("frena por el dia al alcanzar el limite diario, sin apagar el bot", () => {
    const r = checkBreakers(
      state({ equityAtDayStart: 1000, equityPeak: 1000 }),
      960,
      quote(50000),
      cfg({ DAILY_LOSS_LIMIT_PCT: "0.03" }),
    );
    expect(r.blocked).toBe(true);
    expect(r.killSwitch).toBe(false);
  });

  it("frena al llegar al tope de operaciones diarias", () => {
    const r = checkBreakers(state({ tradesToday: 6 }), 1000, quote(50000), cfg({ MAX_TRADES_PER_DAY: "6" }));
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/operaciones hoy/);
  });

  it("respeta el enfriamiento posterior a una operacion", () => {
    const r = checkBreakers(
      state({ lastTradeTime: Date.now() - 5 * 60_000 }),
      1000,
      quote(50000),
      cfg({ COOLDOWN_MIN: "30" }),
    );
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/enfriamiento/);
  });

  it("no opera con el spread demasiado abierto", () => {
    // bid 50000 / ask 50500 -> unos 99 bps, muy por encima del maximo.
    const r = checkBreakers(state(), 1000, quote(50000, 50500), cfg({ MAX_SPREAD_BPS: "20" }));
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/Spread/);
  });

  it("sigue bloqueado mientras el corta-corriente este activo", () => {
    const r = checkBreakers(
      state({ killSwitch: { active: true, reason: "drawdown", since: Date.now() } }),
      1000,
      quote(50000),
      cfg(),
    );
    expect(r.blocked).toBe(true);
    expect(r.killSwitch).toBe(true);
  });
});

describe("computeBuyQuantity", () => {
  const base = {
    equity: 1000,
    cash: 1000,
    quote: quote(50000, 50010),
    candles: candles(60),
    rules,
  };

  it("respeta el limite de exposicion maxima", () => {
    const r = computeBuyQuantity({
      ...base,
      sizeFraction: 1,
      cfg: cfg({ MAX_POSITION_PCT: "0.25", HARD_STOP_PCT: "0.5" }),
    });
    expect(r.rejected).toBeNull();
    expect(r.notional).toBeLessThanOrEqual(1000 * 0.25 + 0.01);
  });

  it("escala el tamano con la fraccion que pide la politica", () => {
    const full = computeBuyQuantity({ ...base, sizeFraction: 1, cfg: cfg({ HARD_STOP_PCT: "0.5" }) });
    const half = computeBuyQuantity({ ...base, sizeFraction: 0.5, cfg: cfg({ HARD_STOP_PCT: "0.5" }) });
    expect(half.notional).toBeLessThan(full.notional);
  });

  it("achica la posicion cuando el stop queda lejos, para no arriesgar de mas", () => {
    // Mas volatilidad -> stop mas lejos -> la misma perdida maxima permite menos cantidad.
    const calm = computeBuyQuantity({ ...base, candles: candles(60, 50000, 100), sizeFraction: 1, cfg: cfg() });
    const wild = computeBuyQuantity({ ...base, candles: candles(60, 50000, 5000), sizeFraction: 1, cfg: cfg() });
    expect(wild.quantity).toBeLessThan(calm.quantity);
  });

  it("no arriesga mas que RISK_PER_TRADE_PCT del equity si salta el stop", () => {
    // La propiedad central del dimensionamiento: cantidad x distancia al stop
    // nunca puede superar la perdida maxima aceptada por operacion.
    const c = cfg({ RISK_PER_TRADE_PCT: "0.01", HARD_STOP_PCT: "0.05", MAX_POSITION_PCT: "1" });
    for (const range of [100, 500, 2000, 5000]) {
      const r = computeBuyQuantity({
        ...base,
        candles: candles(60, 50000, range),
        sizeFraction: 1,
        cfg: c,
      });
      if (r.rejected) continue;
      const { stopPrice } = initialLevels(base.quote.ask, lastAtr(candles(60, 50000, range)), c);
      const lossIfStopped = (base.quote.ask - stopPrice) * r.quantity;
      expect(lossIfStopped).toBeLessThanOrEqual(base.equity * 0.01 + 0.01);
    }
  });

  it("nunca gasta mas efectivo del disponible", () => {
    const r = computeBuyQuantity({
      ...base,
      cash: 50,
      sizeFraction: 1,
      cfg: cfg({ MAX_POSITION_PCT: "1", HARD_STOP_PCT: "0.9" }),
    });
    expect(r.notional).toBeLessThanOrEqual(50);
  });

  it("rechaza ordenes por debajo del minimo en dolares", () => {
    const r = computeBuyQuantity({
      ...base,
      equity: 20,
      cash: 20,
      sizeFraction: 1,
      cfg: cfg({ MIN_ORDER_USD: "10", MAX_POSITION_PCT: "0.25" }),
    });
    expect(r.rejected).toMatch(/por debajo del minimo/);
    expect(r.quantity).toBe(0);
  });

  it("devuelve una cantidad con los decimales que acepta el par", () => {
    const narrow: PairRules = { ...rules, quantityDecimals: 4 };
    const r = computeBuyQuantity({
      ...base,
      rules: narrow,
      sizeFraction: 1,
      cfg: cfg({ HARD_STOP_PCT: "0.5" }),
    });
    expect(r.quantity).toBe(Number(r.quantity.toFixed(4)));
  });
});
