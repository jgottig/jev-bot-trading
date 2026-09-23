import type { Config } from "../config.js";
import type { PairRules } from "../types.js";

/**
 * ¿Alcanza el capital para que este bot tenga sentido?
 *
 * Hay dos formas distintas de que un capital sea insuficiente, y conviene no
 * confundirlas:
 *
 *  1. Mecanica: la posicion queda por debajo del minimo del exchange y el bot
 *     simplemente nunca abre una orden. Es visible enseguida.
 *  2. Economica: el bot opera bien, pero la ganancia posible es tan chica en
 *     terminos absolutos que no cubre el costo de la API que la genera. Esta es
 *     peor, porque el bot parece funcionar mientras destruye valor.
 *
 * Esta verificacion existe para que ambas aparezcan ANTES de fondear la cuenta.
 */

/** Costo anual aproximado de Jev con un ciclo cada 5 minutos. */
export const JEV_ANNUAL_COST_USD = 4.85;

export type ViabilityLevel = "ok" | "warning" | "blocked";

export interface ViabilityReport {
  level: ViabilityLevel;
  /** Tamano de la posicion tipica con la configuracion actual. */
  positionUsd: number;
  /** Minimo que exige la combinacion de exchange y configuracion. */
  minPositionUsd: number;
  /** Capital por debajo del cual el bot no podria abrir ninguna posicion. */
  minCapitalUsd: number;
  /** Que porcentaje de una ganancia anual del 15% se lleva la API. */
  apiCostAsPctOfGain: number;
  messages: string[];
}

export function assessCapital(
  equityUsd: number,
  rules: PairRules,
  cfg: Config,
  price: number,
): ViabilityReport {
  const positionUsd = equityUsd * cfg.MAX_POSITION_PCT;

  // El piso efectivo es el mayor de los tres minimos que aplican.
  const minByPair = rules.minQuantity * price;
  const minPositionUsd = Math.max(cfg.MIN_ORDER_USD, rules.minNotional, minByPair);
  const minCapitalUsd = cfg.MAX_POSITION_PCT > 0 ? minPositionUsd / cfg.MAX_POSITION_PCT : Infinity;

  const plausibleGain = equityUsd * 0.15;
  const apiCostAsPctOfGain =
    plausibleGain > 0 ? (JEV_ANNUAL_COST_USD / plausibleGain) * 100 : Infinity;

  const messages: string[] = [];
  let level: ViabilityLevel = "ok";

  if (positionUsd < minPositionUsd) {
    level = "blocked";
    messages.push(
      `Con USD ${equityUsd.toFixed(2)} y MAX_POSITION_PCT=${cfg.MAX_POSITION_PCT}, la posicion ` +
        `seria de USD ${positionUsd.toFixed(2)}, por debajo del minimo de USD ${minPositionUsd.toFixed(2)}. ` +
        `El bot nunca abriria una operacion.`,
      `Capital minimo para operar con esta configuracion: USD ${minCapitalUsd.toFixed(2)}.`,
    );
  }

  if (apiCostAsPctOfGain > 100) {
    level = "blocked";
    messages.push(
      `Un ano muy bueno (+15%) sobre USD ${equityUsd.toFixed(2)} daria USD ${plausibleGain.toFixed(2)}, ` +
        `menos que los USD ${JEV_ANNUAL_COST_USD} que cuesta la API que toma las decisiones. ` +
        `El bot perderia plata aunque acertara.`,
    );
  } else if (apiCostAsPctOfGain > 25) {
    if (level === "ok") level = "warning";
    messages.push(
      `La API se llevaria el ${apiCostAsPctOfGain.toFixed(0)}% de una ganancia anual del 15%. ` +
        `Funciona, pero el margen es finito.`,
    );
  }

  // Aun con capital suficiente, una posicion apenas por encima del minimo deja
  // al bot sin capacidad de achicarse cuando sube la volatilidad.
  if (level === "ok" && positionUsd < minPositionUsd * 3) {
    level = "warning";
    messages.push(
      `La posicion (USD ${positionUsd.toFixed(2)}) esta cerca del minimo de USD ${minPositionUsd.toFixed(2)}. ` +
        `El bot no va a poder achicarla cuando la volatilidad suba, asi que salteara operaciones.`,
    );
  }

  if (level === "ok") {
    messages.push(
      `Posicion tipica de USD ${positionUsd.toFixed(2)}, holgada sobre el minimo de ` +
        `USD ${minPositionUsd.toFixed(2)}. La API se lleva el ${apiCostAsPctOfGain.toFixed(0)}% ` +
        `de una ganancia anual del 15%.`,
    );
  }

  return { level, positionUsd, minPositionUsd, minCapitalUsd, apiCostAsPctOfGain, messages };
}
