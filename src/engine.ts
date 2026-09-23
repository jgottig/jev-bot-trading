import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { Broker } from "./broker/types.js";
import { PaperBroker } from "./broker/paper.js";
import type { KrakenPublicClient } from "./marketdata/kraken-public.js";
import { atr, last } from "./indicators/index.js";
import { buildDecisionState, type SessionFeatures } from "./brain/features.js";
import type { Brain, JevVerdict } from "./brain/jev.js";
import { decidePlan, type Plan } from "./brain/policy.js";
import { assessEdge, jevCallCostUsd } from "./risk/costs.js";
import {
  checkBreakers,
  checkHardExits,
  checkKillSwitch,
  computeBuyQuantity,
  initialLevels,
  updateTrailingStop,
} from "./risk/manager.js";
import {
  dailyPnlPct,
  drawdownPct,
  rollDay,
  type BotState,
  type ClosedTrade,
  type StateStore,
} from "./state/store.js";
import type { ExitReason, Fill, Position, Quote } from "./types.js";
import { pctChange } from "./util/num.js";

export interface EngineDeps {
  cfg: Config;
  brain: Brain;
  broker: Broker;
  market: KrakenPublicClient;
  store: StateStore;
  logger: Logger;
}

export interface CycleResult {
  time: number;
  equity: number;
  quote: Quote;
  action: "opened" | "closed" | "idle" | "blocked" | "error";
  detail: string;
  verdict: JevVerdict | null;
  plan: Plan | null;
  fill: Fill | null;
}

/** Cuantas velas pedimos: suficiente para que los indicadores largos esten formados. */
const CANDLE_LOOKBACK = 200;

export class TradingEngine {
  private state: BotState;

  constructor(private readonly deps: EngineDeps) {
    this.state = deps.store.load(deps.cfg.PAPER_STARTING_CASH);
    // El simulador vive en memoria, asi que al reiniciar hay que devolverle sus saldos.
    if (this.state.paper && deps.broker instanceof PaperBroker) {
      deps.broker.restore(this.state.paper.cash, this.state.paper.base);
    }
  }

  get currentState(): BotState {
    return this.state;
  }

  private persist(): void {
    this.deps.store.save(this.state);
  }

  private async snapshotPaper(): Promise<void> {
    if (this.deps.broker instanceof PaperBroker) {
      const b = await this.deps.broker.getBalance();
      this.state.paper = { cash: b.cash, base: b.base };
    }
  }

  private buildSession(equity: number, now: number): SessionFeatures {
    return {
      trades_today: this.state.tradesToday,
      realized_pnl_today_pct: Number(dailyPnlPct(this.state, equity).toFixed(3)),
      consecutive_losses: this.state.consecutiveLosses,
      minutes_since_last_trade:
        this.state.lastTradeTime === null
          ? null
          : Number(((now - this.state.lastTradeTime) / 60_000).toFixed(1)),
      drawdown_from_peak_pct: Number(drawdownPct(this.state, equity).toFixed(3)),
    };
  }

  /** Ejecuta un ciclo completo de decision. Es la unidad que corre el loop. */
  async runOnce(): Promise<CycleResult> {
    const { cfg, broker, market, brain, logger } = this.deps;
    const now = Date.now();

    const [candles, quote, rules, balance] = await Promise.all([
      market.getCandles(cfg.PAIR, cfg.CANDLE_INTERVAL_MIN),
      market.getQuote(cfg.PAIR),
      broker.getPairRules(),
      broker.getBalance(),
    ]);

    if (candles.length < 30) {
      return {
        time: now,
        equity: balance.cash,
        quote,
        action: "error",
        detail: `Solo ${candles.length} velas disponibles, hacen falta al menos 30`,
        verdict: null,
        plan: null,
        fill: null,
      };
    }
    const recent = candles.slice(-CANDLE_LOOKBACK);
    const equity = balance.cash + balance.base * quote.last;

    // Registro del equity antes de tocar nada: el drawdown se mide contra el pico real.
    this.state = rollDay(this.state, equity, now);
    if (equity > this.state.equityPeak) this.state.equityPeak = equity;
    this.state.equityCurve.push({ time: now, equity: Number(equity.toFixed(2)) });
    if (this.state.equityCurve.length > 10_000) {
      this.state.equityCurve = this.state.equityCurve.slice(-10_000);
    }

    // El apagado de emergencia se evalua antes que nada: tiene que quedar
    // registrado aunque una salida forzada corte el ciclo unas lineas mas abajo.
    const kill = checkKillSwitch(this.state, equity, cfg);
    if (kill.killSwitch && !this.state.killSwitch.active) {
      this.state.killSwitch = { active: true, reason: kill.reason, since: now };
      logger.error("corta-corriente activado", { reason: kill.reason });
    }

    // --- 1. Salidas duras. Se evaluan ANTES de consultar al modelo -------------
    if (this.state.position) {
      this.state.position = updateTrailingStop(this.state.position, quote, cfg);
      const hard = checkHardExits(this.state.position, quote, cfg, now);
      if (hard) {
        const fill = await this.closePosition(hard.reason, quote, rules.quantityDecimals);
        await this.snapshotPaper();
        this.persist();
        logger.warn("salida forzada", { reason: hard.reason, detail: hard.detail });
        return {
          time: now,
          equity,
          quote,
          action: "closed",
          detail: `${hard.reason}: ${hard.detail}`,
          verdict: null,
          plan: null,
          fill,
        };
      }
    }

    // --- 2. Frenos de riesgo ---------------------------------------------------
    const breaker = checkBreakers(this.state, equity, quote, cfg, now);
    if (breaker.killSwitch && !this.state.killSwitch.active) {
      this.state.killSwitch = { active: true, reason: breaker.reason, since: now };
      logger.error("corta-corriente activado", { reason: breaker.reason });
    }
    // Con posicion abierta seguimos consultando al modelo aunque haya freno:
    // los frenos bloquean entradas, nunca salidas.
    if (breaker.blocked && !this.state.position) {
      this.persist();
      return {
        time: now,
        equity,
        quote,
        action: "blocked",
        detail: breaker.reason ?? "bloqueado",
        verdict: null,
        plan: null,
        fill: null,
      };
    }

    // --- 3. Consulta a Jev -----------------------------------------------------
    const state = buildDecisionState({
      cfg,
      pair: cfg.PAIR,
      intervalMin: cfg.CANDLE_INTERVAL_MIN,
      candles: recent,
      quote,
      position: this.state.position,
      cash: balance.cash,
      baseQuantity: balance.base,
      session: this.buildSession(equity, now),
    });

    const verdict = await brain.decide(state);
    if (verdict.usage) {
      this.state.modelCostUsd += jevCallCostUsd(verdict.usage.inputTokens);
      this.state.modelCalls += 1;
    }
    logger.info("veredicto", {
      action: verdict.action,
      p: verdict.actionProbabilities,
      conviction: Number(verdict.conviction.toFixed(2)),
      regime: verdict.regime,
      downsideRisk: Number(verdict.downsideRisk.toFixed(3)),
      exitNow: Number(verdict.exitNow.toFixed(3)),
      model: verdict.model,
      latencyMs: verdict.latencyMs,
      inputTokens: verdict.usage?.inputTokens,
    });

    // --- 4. Politica ------------------------------------------------------------
    // Rentabilidad esperada frente al costo, calculada sobre los niveles que
    // tendria la operacion si se abriera ahora mismo al precio actual.
    const atrNow = last(atr(recent, 14));
    const projected = initialLevels(quote.ask, atrNow, cfg);
    const edge = assessEdge(quote.ask, projected.targetPrice, quote, cfg);

    const plan = decidePlan(state, verdict, cfg, this.state.position ? undefined : edge);

    if (plan.kind === "close" && this.state.position) {
      const fill = await this.closePosition("model_exit", quote, rules.quantityDecimals);
      await this.snapshotPaper();
      this.persist();
      return { time: now, equity, quote, action: "closed", detail: plan.reason, verdict, plan, fill };
    }

    if (plan.kind === "open" && !this.state.position && !breaker.blocked) {
      const sizing = computeBuyQuantity({
        equity,
        cash: balance.cash,
        quote,
        candles: recent,
        rules,
        sizeFraction: plan.sizeFraction,
        cfg,
      });
      if (sizing.rejected) {
        this.persist();
        return {
          time: now,
          equity,
          quote,
          action: "idle",
          detail: `Senal valida pero no se pudo dimensionar: ${sizing.rejected}`,
          verdict,
          plan,
          fill: null,
        };
      }

      const fill = await broker.placeMarketOrder("buy", sizing.quantity, quote);
      const levels = initialLevels(fill.price, atrNow, cfg);
      this.state.position = {
        quantity: fill.quantity,
        entryPrice: fill.price,
        entryTime: fill.time,
        highWaterPrice: fill.price,
        stopPrice: levels.stopPrice,
        targetPrice: levels.targetPrice,
      };
      this.state.fills.push(fill);
      this.state.tradesToday += 1;
      this.state.lastTradeTime = fill.time;
      await this.snapshotPaper();
      this.persist();

      logger.info("posicion abierta", {
        quantity: fill.quantity,
        price: fill.price,
        stop: Number(levels.stopPrice.toFixed(2)),
        target: Number(levels.targetPrice.toFixed(2)),
        notional: Number((fill.quantity * fill.price).toFixed(2)),
      });
      return { time: now, equity, quote, action: "opened", detail: plan.reason, verdict, plan, fill };
    }

    this.persist();
    return { time: now, equity, quote, action: "idle", detail: plan.reason, verdict, plan, fill: null };
  }

  /** Cierra la posicion entera a mercado y contabiliza el resultado. */
  async closePosition(
    reason: ExitReason,
    quote: Quote,
    quantityDecimals: number,
  ): Promise<Fill> {
    const position = this.state.position;
    if (!position) throw new Error("No hay posicion abierta para cerrar");

    const { broker } = this.deps;
    const balance = await broker.getBalance();
    // Vendemos lo que realmente hay en la cuenta, no lo que creemos tener: una
    // ejecucion parcial o un ajuste manual harian que la orden se rechace entera.
    const available = Math.min(position.quantity, balance.base);
    const quantity = Number(available.toFixed(quantityDecimals));

    const fill = await broker.placeMarketOrder("sell", quantity, quote);

    const entryFee = this.state.fills.find((f) => f.time === position.entryTime)?.fee ?? 0;
    const grossPnl = (fill.price - position.entryPrice) * fill.quantity;
    const pnlUsd = grossPnl - fill.fee - entryFee;
    const closed: ClosedTrade = {
      entryTime: position.entryTime,
      exitTime: fill.time,
      quantity: fill.quantity,
      entryPrice: position.entryPrice,
      exitPrice: fill.price,
      pnlUsd: Number(pnlUsd.toFixed(2)),
      pnlPct: Number(pctChange(position.entryPrice, fill.price).toFixed(3)),
      reason,
    };

    this.state.closedTrades.push(closed);
    this.state.fills.push(fill);
    this.state.position = null;
    this.state.tradesToday += 1;
    this.state.lastTradeTime = fill.time;
    this.state.consecutiveLosses = pnlUsd < 0 ? this.state.consecutiveLosses + 1 : 0;

    this.deps.logger.info("posicion cerrada", {
      reason,
      pnlUsd: closed.pnlUsd,
      pnlPct: closed.pnlPct,
      entryPrice: closed.entryPrice,
      exitPrice: closed.exitPrice,
    });
    await this.snapshotPaper();
    return fill;
  }

  /** Cierra todo y desactiva entradas. Lo usa el comando `flat`. */
  async flatten(reason: ExitReason = "manual"): Promise<Fill | null> {
    const { cfg, market, broker } = this.deps;
    if (!this.state.position) return null;
    const [quote, rules] = await Promise.all([
      market.getQuote(cfg.PAIR),
      broker.getPairRules(),
    ]);
    const fill = await this.closePosition(reason, quote, rules.quantityDecimals);
    this.persist();
    return fill;
  }

  /** Reactiva el bot despues de un corta-corriente, una vez revisado por un humano. */
  resetKillSwitch(): void {
    this.state.killSwitch = { active: false, reason: null, since: null };
    this.persist();
  }
}

export type { Position };
