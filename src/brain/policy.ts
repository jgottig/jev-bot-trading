import type { Config } from "../config.js";
import { clamp } from "../util/num.js";
import type { EdgeAssessment } from "../risk/costs.js";
import type { DecisionState } from "./features.js";
import type { JevVerdict } from "./jev.js";

/**
 * La politica traduce probabilidades en una intencion de operar.
 *
 * Jev devuelve que tan probable es cada cosa; nunca devuelve "compra". La
 * decision de mover plata la toma este archivo, con umbrales explicitos que
 * estan en la configuracion y se pueden auditar. Esto es deliberado: si manana
 * el modelo cambia de version y se vuelve mas optimista, el riesgo no se mueve
 * salvo que alguien edite estos numeros a mano.
 */

export type PlanKind = "open" | "close" | "none";

export interface Plan {
  kind: PlanKind;
  /** Explicacion legible de por que se llego a esto, para el log y la auditoria. */
  reason: string;
  /** Solo para "open": que fraccion del tamano maximo usar, entre 0 y 1. */
  sizeFraction: number;
  /** Cada condicion evaluada y si paso o no. Queda registrada siempre. */
  gates: { name: string; passed: boolean; detail: string }[];
}

interface Gate {
  name: string;
  passed: boolean;
  detail: string;
}

function gate(name: string, passed: boolean, detail: string): Gate {
  return { name, passed, detail };
}

export function decidePlan(
  state: DecisionState,
  verdict: JevVerdict,
  cfg: Config,
  /**
   * Rentabilidad esperada de la operacion frente a su costo. Se calcula fuera
   * porque necesita el ATR y los niveles de stop y objetivo, que son del
   * gestor de riesgo. Si no viene, la compuerta de costo no se evalua.
   */
  edge?: EdgeAssessment,
): Plan {
  const open = state.portfolio.has_open_position;

  // --- Con posicion abierta: la unica pregunta es si el modelo quiere salir ----
  if (open) {
    const gates: Gate[] = [
      gate(
        "exit_probability",
        verdict.exitNow >= cfg.EXIT_PROBABILITY,
        `exit_now=${verdict.exitNow.toFixed(3)} vs umbral ${cfg.EXIT_PROBABILITY}`,
      ),
      gate(
        "sell_signal",
        verdict.action === "sell" &&
          verdict.actionProbabilities.sell >= cfg.MIN_BUY_PROBABILITY,
        `action=${verdict.action} p(sell)=${verdict.actionProbabilities.sell.toFixed(3)}`,
      ),
    ];
    // Alcanza con que se cumpla una de las dos: son dos formas de preguntar lo mismo.
    const shouldExit = gates.some((g) => g.passed);
    return {
      kind: shouldExit ? "close" : "none",
      sizeFraction: 0,
      reason: shouldExit
        ? `El modelo pide cerrar (${gates.filter((g) => g.passed).map((g) => g.name).join(", ")})`
        : "Posicion abierta sin senal de salida: la dejamos correr con su stop y su objetivo",
      gates,
    };
  }

  // --- Sin posicion: todas las compuertas tienen que dar verde ----------------
  const gates: Gate[] = [
    gate("entries_enabled", cfg.ALLOW_ENTRIES, `ALLOW_ENTRIES=${cfg.ALLOW_ENTRIES}`),
    gate("action_is_buy", verdict.action === "buy", `action=${verdict.action}`),
    gate(
      "buy_probability",
      verdict.actionProbabilities.buy >= cfg.MIN_BUY_PROBABILITY,
      `p(buy)=${verdict.actionProbabilities.buy.toFixed(3)} vs minimo ${cfg.MIN_BUY_PROBABILITY}`,
    ),
    gate(
      "confidence",
      verdict.actionConfidence >= cfg.MIN_CONFIDENCE,
      `confianza=${verdict.actionConfidence.toFixed(3)} vs minimo ${cfg.MIN_CONFIDENCE}`,
    ),
    gate(
      "conviction",
      verdict.conviction >= cfg.MIN_CONVICTION,
      `conviccion=${verdict.conviction.toFixed(2)} vs minimo ${cfg.MIN_CONVICTION}`,
    ),
    gate(
      "downside_risk",
      verdict.downsideRisk <= cfg.MAX_RISK_PROBABILITY,
      `riesgo=${verdict.downsideRisk.toFixed(3)} vs maximo ${cfg.MAX_RISK_PROBABILITY}`,
    ),
    gate(
      "regime",
      verdict.regime !== "trending_down",
      `regimen=${verdict.regime}`,
    ),
    gate(
      "spread",
      state.market.price.spread_bps <= cfg.MAX_SPREAD_BPS,
      `spread=${state.market.price.spread_bps.toFixed(2)}bps vs maximo ${cfg.MAX_SPREAD_BPS}`,
    ),
  ];

  // La operacion tiene que apuntar a un movimiento que justifique su costo.
  // Sin esta compuerta el bot opera mucho y le entrega el resultado al exchange:
  // con el arancel base, una vuelta cuesta ~0.80% y el objetivo tipico de una
  // vela corta no llega a cubrirlo.
  if (edge) {
    gates.push(
      gate(
        "cost_edge",
        edge.sufficient,
        `objetivo=${edge.targetBps.toFixed(1)}bps vs costo=${edge.costBps.toFixed(1)}bps ` +
          `(${edge.edgeMultiple.toFixed(2)}x, minimo ${cfg.MIN_EDGE_MULTIPLE}x), ` +
          `neto=${edge.netBps.toFixed(1)}bps`,
      ),
    );
  }

  const failed = gates.filter((g) => !g.passed);
  if (failed.length > 0) {
    return {
      kind: "none",
      sizeFraction: 0,
      reason: `No se abre: ${failed.map((g) => g.name).join(", ")}`,
      gates,
    };
  }

  return {
    kind: "open",
    sizeFraction: sizeFractionFor(verdict, cfg),
    reason:
      `Compra habilitada con conviccion ${verdict.conviction.toFixed(2)} en regimen ${verdict.regime}` +
      (edge ? `, objetivo cubre ${edge.edgeMultiple.toFixed(2)}x el costo` : ""),
    gates,
  };
}

/**
 * Cuanto del tamano maximo usar, entre 0 y 1.
 *
 * Una senal que apenas supera el umbral no merece el mismo tamano que una
 * unanime, asi que escalamos con la conviccion. El piso de 0.4 evita ordenes tan
 * chicas que la comision se coma el resultado.
 */
export function sizeFractionFor(verdict: JevVerdict, cfg: Config): number {
  const span = Math.max(0.001, 4 - cfg.MIN_CONVICTION);
  const normalized = clamp((verdict.conviction - cfg.MIN_CONVICTION) / span, 0, 1);
  let fraction = 0.4 + 0.6 * normalized;

  // En regimen erratico los stops saltan por ruido: entramos con la mitad.
  if (verdict.regime === "high_volatility") fraction *= 0.5;
  // Y descontamos proporcionalmente el riesgo de caida que el propio modelo reporta.
  fraction *= 1 - 0.5 * verdict.downsideRisk;

  return clamp(fraction, 0, 1);
}
