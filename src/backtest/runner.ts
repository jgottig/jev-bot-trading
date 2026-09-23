import { buildDecisionState } from "../brain/features.js";
import type { Brain } from "../brain/jev.js";
import { decidePlan } from "../brain/policy.js";
import type { Config } from "../config.js";
import { atr, last } from "../indicators/index.js";
import {
  checkHardExits,
  computeBuyQuantity,
  initialLevels,
  updateTrailingStop,
} from "../risk/manager.js";
import { assessEdge } from "../risk/costs.js";
import type { Candle, ExitReason, PairRules, Position, Quote } from "../types.js";
import { floorTo, pctChange } from "../util/num.js";

/**
 * Backtest sobre velas historicas.
 *
 * Reutiliza exactamente los mismos modulos de features, politica y riesgo que la
 * operacion en vivo. Eso es deliberado: un backtest que reimplementa la logica
 * termina midiendo un bot que no existe.
 *
 * Limitaciones que hay que tener presentes al leer los resultados:
 *  - Cada vela se evalua en su cierre; no vemos lo que pasa adentro de la vela.
 *  - El stop se ejecuta al precio del stop, sin simular huecos de precio.
 *  - El spread se asume constante; en la realidad se abre justo cuando peor viene.
 * Por eso un backtest bueno es condicion necesaria, nunca suficiente.
 */

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsd: number;
  pnlPct: number;
  reason: ExitReason;
}

export interface BacktestResult {
  startEquity: number;
  endEquity: number;
  returnPct: number;
  /** Rendimiento de comprar y sostener en el mismo periodo, como referencia. */
  buyAndHoldPct: number;
  trades: BacktestTrade[];
  wins: number;
  losses: number;
  winRatePct: number;
  maxDrawdownPct: number;
  totalFees: number;
  candlesEvaluated: number;
  equityCurve: { time: number; equity: number }[];
}

export interface BacktestOptions {
  candles: Candle[];
  cfg: Config;
  brain: Brain;
  rules: PairRules;
  /** Velas iniciales reservadas para que los indicadores se formen. */
  warmup?: number;
}

/** Cotizacion sintetica a partir del cierre, abriendo el spread configurado. */
function quoteFromCandle(candle: Candle, spreadBps: number): Quote {
  const half = (candle.close * spreadBps) / 10_000 / 2;
  return {
    bid: candle.close - half,
    ask: candle.close + half,
    last: candle.close,
    time: candle.time,
  };
}

export async function runBacktest(opts: BacktestOptions): Promise<BacktestResult> {
  const { candles, cfg, brain, rules } = opts;
  const warmup = opts.warmup ?? 60;

  if (candles.length <= warmup + 1) {
    throw new Error(
      `Hacen falta mas de ${warmup + 1} velas para backtestear, llegaron ${candles.length}`,
    );
  }

  const spread = Math.min(cfg.MAX_SPREAD_BPS / 2, 10);
  const slip = cfg.PAPER_SLIPPAGE_BPS / 10_000;

  let cash = cfg.PAPER_STARTING_CASH;
  let base = 0;
  let position: Position | null = null;
  let peak = cash;
  let maxDd = 0;
  let totalFees = 0;
  let entryFee = 0;
  let tradesToday = 0;
  let dayKey = "";
  let lastTradeTime: number | null = null;

  const trades: BacktestTrade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];

  const sell = (quote: Quote, quantity: number, reason: ExitReason, time: number): void => {
    if (!position) return;
    const price = quote.bid * (1 - slip);
    const notional = price * quantity;
    const fee = notional * cfg.FEE_RATE;
    cash += notional - fee;
    base -= quantity;
    totalFees += fee;

    trades.push({
      entryTime: position.entryTime,
      exitTime: time,
      entryPrice: position.entryPrice,
      exitPrice: price,
      quantity,
      pnlUsd: Number(((price - position.entryPrice) * quantity - fee - entryFee).toFixed(2)),
      pnlPct: Number(pctChange(position.entryPrice, price).toFixed(3)),
      reason,
    });
    position = null;
    entryFee = 0;
    tradesToday += 1;
    lastTradeTime = time;
  };

  for (let i = warmup; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - 199), i + 1);
    const candle = candles[i]!;
    const quote = quoteFromCandle(candle, spread);
    const equity = cash + base * candle.close;

    equityCurve.push({ time: candle.time, equity: Number(equity.toFixed(2)) });
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;

    const key = new Date(candle.time).toISOString().slice(0, 10);
    if (key !== dayKey) {
      dayKey = key;
      tradesToday = 0;
    }

    // Salidas duras primero, igual que en vivo.
    if (position) {
      position = updateTrailingStop(position, quote, cfg);
      const hard = checkHardExits(position, quote, cfg, candle.time);
      if (hard) {
        sell(quote, position.quantity, hard.reason, candle.time);
        continue;
      }
    }

    const state = buildDecisionState({
      cfg,
      pair: cfg.PAIR,
      intervalMin: cfg.CANDLE_INTERVAL_MIN,
      candles: window,
      quote,
      position,
      cash,
      baseQuantity: base,
      session: {
        trades_today: tradesToday,
        realized_pnl_today_pct: 0,
        consecutive_losses: 0,
        minutes_since_last_trade:
          lastTradeTime === null ? null : (candle.time - lastTradeTime) / 60_000,
        drawdown_from_peak_pct: Number(dd.toFixed(3)),
      },
    });

    const verdict = await brain.decide(state);
    const atrNow = last(atr(window, 14));
    const projected = initialLevels(quote.ask, atrNow, cfg);
    const edge = assessEdge(quote.ask, projected.targetPrice, quote, cfg);
    const plan = decidePlan(state, verdict, cfg, position ? undefined : edge);

    if (plan.kind === "close" && position) {
      sell(quote, position.quantity, "model_exit", candle.time);
      continue;
    }

    const cooling =
      lastTradeTime !== null && (candle.time - lastTradeTime) / 60_000 < cfg.COOLDOWN_MIN;
    if (
      plan.kind === "open" &&
      !position &&
      !cooling &&
      tradesToday < cfg.MAX_TRADES_PER_DAY
    ) {
      const sizing = computeBuyQuantity({
        equity,
        cash,
        quote,
        candles: window,
        rules,
        sizeFraction: plan.sizeFraction,
        cfg,
      });
      if (sizing.rejected) continue;

      const price = quote.ask * (1 + slip);
      const quantity = floorTo(sizing.quantity, rules.quantityDecimals);
      const notional = price * quantity;
      const fee = notional * cfg.FEE_RATE;
      if (notional + fee > cash) continue;

      cash -= notional + fee;
      base += quantity;
      totalFees += fee;
      entryFee = fee;
      tradesToday += 1;
      lastTradeTime = candle.time;

      const levels = initialLevels(price, atrNow, cfg);
      position = {
        quantity,
        entryPrice: price,
        entryTime: candle.time,
        highWaterPrice: price,
        stopPrice: levels.stopPrice,
        targetPrice: levels.targetPrice,
      };
    }
  }

  // Cerramos al final para que el resultado sea comparable con comprar y sostener.
  const lastCandle = candles.at(-1)!;
  if (position) {
    sell(quoteFromCandle(lastCandle, spread), position.quantity, "manual", lastCandle.time);
  }

  const endEquity = cash + base * lastCandle.close;
  const firstClose = candles[warmup]!.close;
  const wins = trades.filter((t) => t.pnlUsd > 0).length;

  return {
    startEquity: cfg.PAPER_STARTING_CASH,
    endEquity: Number(endEquity.toFixed(2)),
    returnPct: Number(pctChange(cfg.PAPER_STARTING_CASH, endEquity).toFixed(3)),
    buyAndHoldPct: Number(pctChange(firstClose, lastCandle.close).toFixed(3)),
    trades,
    wins,
    losses: trades.length - wins,
    winRatePct: trades.length > 0 ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    maxDrawdownPct: Number(maxDd.toFixed(3)),
    totalFees: Number(totalFees.toFixed(2)),
    candlesEvaluated: candles.length - warmup,
    equityCurve,
  };
}
