import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";
import type { Action } from "../types.js";
import type { DecisionState } from "./features.js";

/**
 * Jev no genera texto: responde preguntas tipadas sobre un estado.
 *
 * Por eso el diseno del bot es al reves de lo que se suele hacer con un LLM.
 * No le pedimos "decime que hago". Le hacemos preguntas concretas y acotadas,
 * y recibimos probabilidades. Despues nuestro codigo (policy.ts) decide, con
 * umbrales explicitos, si esas probabilidades alcanzan para mover plata.
 *
 * Las preguntas estan escritas en ingles a proposito: TypeSafe documenta que el
 * modelo esta calibrado principalmente en ingles y que otros idiomas hay que
 * medirlos aparte. No es una decision estetica, afecta la calidad de la salida.
 */

export type Regime = "trending_up" | "trending_down" | "ranging" | "high_volatility";

export interface JevVerdict {
  action: Action;
  actionProbabilities: Record<Action, number>;
  actionConfidence: number;
  /** Rubrica 0-4: 0 = ninguna conviccion, 4 = muy alta. Puede ser fraccionario. */
  conviction: number;
  convictionConfidence: number;
  regime: Regime;
  regimeConfidence: number;
  /** Probabilidad 0-1 de que haya riesgo elevado de caida en el corto plazo. */
  downsideRisk: number;
  /** Probabilidad 0-1 de que convenga cerrar ya la posicion abierta. */
  exitNow: number;
  model: string;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Cualquier cosa capaz de emitir un veredicto sobre el estado del mercado. */
export interface Brain {
  readonly name: string;
  decide(state: DecisionState): Promise<JevVerdict>;
}

/** Las preguntas que le hacemos a Jev en cada ciclo, en una sola llamada. */
export const TRADING_QUESTIONS = {
  action: choice(
    "Given the market state and the current portfolio, what is the best next action for a spot, long-only Bitcoin bot that cannot short and cannot use leverage?",
    {
      buy: "Open a new long position, or add to the existing one, because the evidence favours an upward move from here.",
      sell: "Close the existing long position, because the evidence favours a downward move or the move that justified the entry is over.",
      hold: "Do nothing right now: the evidence is mixed, weak, or already priced in.",
    },
  ),
  conviction: score(
    "How strong is the evidence supporting the action you chose? Judge only the strength of the signal, not whether the action is safe.",
    [
      "No evidence: the indicators disagree with each other or show nothing.",
      "Weak: one indicator leans that way, the rest are neutral.",
      "Moderate: several indicators agree but the move is not confirmed by volume or trend.",
      "Strong: trend, momentum and volume point the same way.",
      "Very strong: every indicator aligns and the move is confirmed by volume.",
    ],
  ),
  regime: choice("Which regime best describes the current market state?", {
    trending_up: "A sustained upward trend: higher highs, price above its slow moving average which is rising.",
    trending_down: "A sustained downward trend: lower lows, price below its slow moving average which is falling.",
    ranging: "No clear direction: price oscillates inside a band and volatility is low.",
    high_volatility: "Large erratic swings without a stable direction, where stops are likely to be hit by noise.",
  }),
  downside_risk: noul(
    "Is there an elevated risk of a sharp adverse move against a long position within the next few candles?",
    {
      true: "Signs of exhaustion, negative divergence, unusual volume on down candles, or volatility expanding against the trend.",
      false: "Conditions look orderly for holding or opening a long position.",
    },
  ),
  exit_now: noul(
    "If a long position is currently open, should it be closed immediately, regardless of its stop loss and take profit levels?",
    {
      true: "The reason for the entry no longer holds, or the setup has clearly broken down.",
      false: "The position can stay open and let its stop loss and take profit do their job.",
    },
  ),
} as const;

export interface JevBrainOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/** Implementacion real: consulta al modelo Jev de TypeSafe AI. */
export class JevBrain implements Brain {
  readonly name = "jev";
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(opts: JevBrainOptions = {}) {
    this.model = opts.model ?? "jev-latest";
    this.client = new TypeSafeClient({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      defaultModel: this.model,
      timeout: opts.timeoutMs ?? 15_000,
      // Un ciclo perdido no es grave: el proximo llega en minutos. Preferimos
      // reintentar poco y fallar rapido antes que colgar el loop.
      retry: { maxRetries: 2 },
    });
  }

  async decide(state: DecisionState): Promise<JevVerdict> {
    const started = Date.now();
    // Pasamos por JSON para garantizar que lo que viaja sea serializable y que
    // ningun `undefined` se cuele en el cuerpo del pedido.
    const payload = JSON.parse(JSON.stringify(state)) as { [key: string]: JsonValue };
    const result = await this.client.systemOne({
      state: payload,
      questions: TRADING_QUESTIONS,
      model: this.model,
    });
    const a = result.answers;

    return {
      action: a.action.choice as Action,
      actionProbabilities: {
        buy: a.action.probabilities.buy,
        sell: a.action.probabilities.sell,
        hold: a.action.probabilities.hold,
      },
      actionConfidence: a.action.confidence,
      conviction: a.conviction.score,
      convictionConfidence: a.conviction.confidence,
      regime: a.regime.choice as Regime,
      regimeConfidence: a.regime.confidence,
      downsideRisk: a.downside_risk.noul,
      exitNow: a.exit_now.noul,
      model: result.model,
      latencyMs: Date.now() - started,
      usage: {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      },
    };
  }

  /** Lista los modelos disponibles para la cuenta. Lo usa `doctor`. */
  async listModels() {
    return this.client.models.list();
  }
}
