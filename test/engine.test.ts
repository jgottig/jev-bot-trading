import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionState } from "../src/brain/features.js";
import type { Brain, JevVerdict } from "../src/brain/jev.js";
import { PaperBroker } from "../src/broker/paper.js";
import { loadConfig, type Config } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { Logger } from "../src/logger.js";
import { KrakenPublicClient } from "../src/marketdata/kraken-public.js";
import { StateStore } from "../src/state/store.js";
import type { PairRules } from "../src/types.js";

const rules: PairRules = { priceDecimals: 1, quantityDecimals: 8, minQuantity: 0.0001, minNotional: 5 };

/** Cerebro de prueba: devuelve el veredicto que le dictemos en cada ciclo. */
class ScriptedBrain implements Brain {
  readonly name = "scripted";
  public seen: DecisionState[] = [];
  constructor(private verdicts: JevVerdict[]) {}

  async decide(state: DecisionState): Promise<JevVerdict> {
    this.seen.push(state);
    return this.verdicts.shift() ?? verdict({ action: "hold" });
  }
}

function verdict(over: Partial<JevVerdict> = {}): JevVerdict {
  return {
    action: "buy",
    actionProbabilities: { buy: 0.85, sell: 0.05, hold: 0.1 },
    actionConfidence: 0.85,
    conviction: 3.5,
    convictionConfidence: 0.8,
    regime: "trending_up",
    regimeConfidence: 0.8,
    downsideRisk: 0.1,
    exitNow: 0.02,
    model: "scripted",
    latencyMs: 1,
    ...over,
  };
}

/** Cliente de mercado servido por un fetch falso, con el precio que pidamos. */
function marketAt(price: number, opts: { spread?: number; trend?: number } = {}): KrakenPublicClient {
  const spread = opts.spread ?? 10;
  const trend = opts.trend ?? 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/OHLC")) {
      const rows = Array.from({ length: 120 }, (_, i) => {
        const p = price - trend * (120 - i);
        return [String(1_700_000_000 + i * 900), String(p), String(p + 50), String(p - 50), String(p), String(p), "10", 5];
      });
      return new Response(JSON.stringify({ error: [], result: { XXBTZUSD: rows, last: 0 } }));
    }
    if (url.includes("/Ticker")) {
      return new Response(
        JSON.stringify({
          error: [],
          result: {
            XXBTZUSD: {
              a: [String(price + spread / 2), "1", "1"],
              b: [String(price - spread / 2), "1", "1"],
              c: [String(price), "0.1"],
            },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        error: [],
        result: {
          XXBTZUSD: { base: "XXBT", quote: "ZUSD", pair_decimals: 1, lot_decimals: 8, ordermin: "0.0001", costmin: "5" },
        },
      }),
    );
  });
  return new KrakenPublicClient(fetchMock);
}

describe("TradingEngine", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevbot-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function cfg(over: Record<string, string> = {}): Config {
    return loadConfig({
      MODE: "paper",
      DATA_DIR: dir,
      PAPER_STARTING_CASH: "1000",
      COOLDOWN_MIN: "0",
      LOG_LEVEL: "error",
      ...over,
    } as NodeJS.ProcessEnv);
  }

  function engineWith(
    config: Config,
    brain: Brain,
    price = 50000,
    marketOpts: { spread?: number; trend?: number } = {},
  ) {
    const broker = new PaperBroker({
      startingCash: config.PAPER_STARTING_CASH,
      feeRate: config.FEE_RATE,
      slippageBps: config.PAPER_SLIPPAGE_BPS,
      rules,
    });
    const engine = new TradingEngine({
      cfg: config,
      brain,
      broker,
      market: marketAt(price, marketOpts),
      store: new StateStore(config.DATA_DIR),
      logger: new Logger("error"),
    });
    return { engine, broker };
  }

  it("abre una posicion cuando el veredicto pasa todas las compuertas", async () => {
    const c = cfg();
    const { engine } = engineWith(c, new ScriptedBrain([verdict()]));
    const result = await engine.runOnce();

    expect(result.action).toBe("opened");
    expect(result.fill?.side).toBe("buy");
    const position = engine.currentState.position;
    expect(position).not.toBeNull();
    expect(position!.stopPrice).toBeLessThan(position!.entryPrice);
    expect(position!.targetPrice).toBeGreaterThan(position!.entryPrice);
  });

  it("no abre nada si el veredicto es mantener", async () => {
    const { engine } = engineWith(cfg(), new ScriptedBrain([verdict({ action: "hold" })]));
    const result = await engine.runOnce();
    expect(result.action).toBe("idle");
    expect(engine.currentState.position).toBeNull();
  });

  it("le pasa a Jev un estado con las features ya calculadas", async () => {
    const brain = new ScriptedBrain([verdict({ action: "hold" })]);
    const { engine } = engineWith(cfg(), brain);
    await engine.runOnce();

    const state = brain.seen[0]!;
    expect(state.market.pair).toBe("XBTUSD");
    expect(state.market.price.last).toBeGreaterThan(0);
    expect(state.market.momentum.rsi_14).not.toBeNull();
    expect(state.market.trend.ema_slow).not.toBeNull();
    expect(state.market.recent_candles.length).toBe(12);
    expect(state.portfolio.has_open_position).toBe(false);
  });

  it("ejecuta el stop loss sin consultar al modelo", async () => {
    const c = cfg();
    const brain = new ScriptedBrain([verdict()]);
    const { engine, broker } = engineWith(c, brain);
    await engine.runOnce();

    const entry = engine.currentState.position!;
    const consultasAntes = brain.seen.length;

    // El precio se desploma por debajo del stop.
    const crashed = new TradingEngine({
      cfg: c,
      brain,
      broker,
      market: marketAt(entry.stopPrice - 500),
      store: new StateStore(c.DATA_DIR),
      logger: new Logger("error"),
    });
    const result = await crashed.runOnce();

    expect(result.action).toBe("closed");
    expect(result.detail).toMatch(/stop_loss/);
    // Lo importante: la salida no paso por el cerebro.
    expect(brain.seen.length).toBe(consultasAntes);
  });

  it("toma ganancias al alcanzar el objetivo", async () => {
    const c = cfg();
    const { engine, broker } = engineWith(c, new ScriptedBrain([verdict()]));
    await engine.runOnce();
    const target = engine.currentState.position!.targetPrice;

    const up = new TradingEngine({
      cfg: c,
      brain: new ScriptedBrain([]),
      broker,
      market: marketAt(target + 1000),
      store: new StateStore(c.DATA_DIR),
      logger: new Logger("error"),
    });
    const result = await up.runOnce();
    expect(result.action).toBe("closed");
    expect(result.detail).toMatch(/take_profit/);
  });

  it("cierra cuando el modelo pide salir", async () => {
    const c = cfg();
    const { engine, broker } = engineWith(c, new ScriptedBrain([verdict()]));
    await engine.runOnce();

    const exiting = new TradingEngine({
      cfg: c,
      brain: new ScriptedBrain([verdict({ exitNow: 0.95 })]),
      broker,
      market: marketAt(50100),
      store: new StateStore(c.DATA_DIR),
      logger: new Logger("error"),
    });
    const result = await exiting.runOnce();
    expect(result.action).toBe("closed");
    expect(engine.currentState.position).toBeNull;
  });

  it("no opera con el spread demasiado abierto", async () => {
    const c = cfg({ MAX_SPREAD_BPS: "20" });
    const { engine } = engineWith(c, new ScriptedBrain([verdict()]), 50000, { spread: 1000 });
    const result = await engine.runOnce();
    expect(result.action).toBe("blocked");
    expect(result.detail).toMatch(/Spread/);
  });

  it("frena las entradas al alcanzar el tope diario de operaciones", async () => {
    const c = cfg({ MAX_TRADES_PER_DAY: "1" });
    const { engine, broker } = engineWith(c, new ScriptedBrain([verdict()]));
    await engine.runOnce();
    await engine.flatten("manual");

    const again = new TradingEngine({
      cfg: c,
      brain: new ScriptedBrain([verdict()]),
      broker,
      market: marketAt(50000),
      store: new StateStore(c.DATA_DIR),
      logger: new Logger("error"),
    });
    const result = await again.runOnce();
    expect(result.action).toBe("blocked");
    expect(result.detail).toMatch(/operaciones hoy/);
  });

  it("persiste el estado y lo recupera al reiniciar", async () => {
    const c = cfg();
    const { engine } = engineWith(c, new ScriptedBrain([verdict()]));
    await engine.runOnce();
    const entryPrice = engine.currentState.position!.entryPrice;

    // Un proceso nuevo, con su propio broker en memoria.
    const fresh = new TradingEngine({
      cfg: c,
      brain: new ScriptedBrain([verdict({ action: "hold" })]),
      broker: new PaperBroker({
        startingCash: c.PAPER_STARTING_CASH,
        feeRate: c.FEE_RATE,
        slippageBps: c.PAPER_SLIPPAGE_BPS,
        rules,
      }),
      market: marketAt(50000),
      store: new StateStore(c.DATA_DIR),
      logger: new Logger("error"),
    });

    expect(fresh.currentState.position?.entryPrice).toBe(entryPrice);
    // El simulador recupero sus saldos, no volvio a arrancar con los 1000 iniciales.
    const balance = await fresh.currentState.paper;
    expect(balance!.base).toBeGreaterThan(0);
    expect(balance!.cash).toBeLessThan(1000);
  });

  it("activa el corta-corriente al superar el drawdown maximo", async () => {
    const c = cfg({ MAX_DRAWDOWN_PCT: "0.1", DAILY_LOSS_LIMIT_PCT: "0.05" });
    const { engine, broker } = engineWith(c, new ScriptedBrain([verdict()]));
    await engine.runOnce();

    // Caida brutal: el equity se hunde muy por debajo del pico.
    const crash = new TradingEngine({
      cfg: c,
      brain: new ScriptedBrain([verdict({ action: "hold" })]),
      broker,
      market: marketAt(20000),
      store: new StateStore(c.DATA_DIR),
      logger: new Logger("error"),
    });
    await crash.runOnce();
    expect(crash.currentState.killSwitch.active).toBe(true);
  });

  it("registra la operacion cerrada con su resultado neto de comisiones", async () => {
    const c = cfg();
    const { engine } = engineWith(c, new ScriptedBrain([verdict()]));
    await engine.runOnce();
    await engine.flatten("manual");

    const trades = engine.currentState.closedTrades;
    expect(trades).toHaveLength(1);
    expect(trades[0]!.reason).toBe("manual");
    // Entrar y salir sin movimiento de precio tiene que dar perdida.
    expect(trades[0]!.pnlUsd).toBeLessThan(0);
  });

  it("no deja el bot caido si un ciclo falla al pedir datos", async () => {
    const c = cfg();
    const failing = new KrakenPublicClient(
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const engine = new TradingEngine({
      cfg: c,
      brain: new ScriptedBrain([verdict()]),
      broker: new PaperBroker({
        startingCash: 1000,
        feeRate: c.FEE_RATE,
        slippageBps: c.PAPER_SLIPPAGE_BPS,
        rules,
      }),
      market: failing,
      store: new StateStore(c.DATA_DIR),
      logger: new Logger("error"),
    });
    await expect(engine.runOnce()).rejects.toThrow();
    // El estado en disco sigue siendo valido para el proximo ciclo.
    expect(engine.currentState.position).toBeNull();
  });

  it("resetKillSwitch vuelve a habilitar las entradas", async () => {
    const c = cfg();
    const { engine } = engineWith(c, new ScriptedBrain([verdict({ action: "hold" })]));
    await engine.runOnce();
    engine.currentState.killSwitch = { active: true, reason: "test", since: Date.now() };
    engine.resetKillSwitch();
    expect(engine.currentState.killSwitch.active).toBe(false);
  });
});
