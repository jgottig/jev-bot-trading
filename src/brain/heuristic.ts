import type { Action } from "../types.js";
import type { DecisionState } from "./features.js";
import type { Brain, JevVerdict, Regime } from "./jev.js";

/**
 * Cerebro deterministico de reglas, con la misma salida que Jev.
 *
 * Existe por dos motivos concretos:
 *  1. El backtest recorre miles de velas. Llamar al modelo en cada una costaria
 *     plata y tardaria horas; ademas, un backtest tiene que ser reproducible.
 *  2. Es la linea de base contra la cual se mide si Jev aporta algo. Si el bot
 *     con Jev no le gana a estas reglas simples, el modelo no esta sumando nada
 *     y conviene saberlo antes de poner plata.
 *
 * No pretende ser una buena estrategia: pretende ser una vara honesta.
 */
export class HeuristicBrain implements Brain {
  readonly name = "heuristic";

  async decide(state: DecisionState): Promise<JevVerdict> {
    const { market, portfolio } = state;
    const gap = market.trend.ema_gap_pct ?? 0;
    const slope = market.trend.ema_slow_slope_pct ?? 0;
    const rsi = market.momentum.rsi_14 ?? 50;
    const hist = market.momentum.macd_histogram_pct ?? 0;
    const volZ = market.volume.z_score ?? 0;
    const atrPct = market.volatility.atr_pct ?? 1;

    const regime: Regime =
      atrPct > 3
        ? "high_volatility"
        : gap > 0.15 && slope > 0
          ? "trending_up"
          : gap < -0.15 && slope < 0
            ? "trending_down"
            : "ranging";

    // Sumamos senales independientes; cada una vale un punto.
    let bull = 0;
    if (gap > 0) bull++;
    if (slope > 0) bull++;
    if (hist > 0) bull++;
    if (rsi > 50 && rsi < 70) bull++;
    if (volZ > 0.5) bull++;

    let bear = 0;
    if (gap < 0) bear++;
    if (slope < 0) bear++;
    if (hist < 0) bear++;
    if (rsi < 45) bear++;
    if (rsi > 75) bear++; // Sobrecompra: tambien es motivo para salir.

    let action: Action = "hold";
    if (!portfolio.has_open_position && bull >= 4 && regime !== "trending_down") action = "buy";
    else if (portfolio.has_open_position && bear >= 3) action = "sell";

    const strength = Math.max(bull, bear);
    const conviction = Math.min(4, Math.max(0, strength - 1));
    const total = bull + bear || 1;

    const probabilities: Record<Action, number> = {
      buy: action === "buy" ? 0.5 + bull / (2 * total) : bull / (2 * total),
      sell: action === "sell" ? 0.5 + bear / (2 * total) : bear / (2 * total),
      hold: 0,
    };
    probabilities.hold = Math.max(0, 1 - probabilities.buy - probabilities.sell);

    return {
      action,
      actionProbabilities: probabilities,
      actionConfidence: 0.5 + conviction / 10,
      conviction,
      convictionConfidence: 0.6,
      regime,
      regimeConfidence: 0.6,
      downsideRisk: Math.min(1, Math.max(0, bear / 5)),
      exitNow: portfolio.has_open_position && bear >= 4 ? 0.8 : 0.1,
      model: "heuristic-v1",
      latencyMs: 0,
    };
  }
}
