import type { Config } from "../config.js";
import type { Quote } from "../types.js";
import { spreadBps } from "../types.js";

/**
 * Modelo de costos de una operacion.
 *
 * Existe porque el costo de operar no es un detalle contable que se mira
 * despues: en este mercado decide si una operacion tiene sentido o no.
 *
 * Con el arancel base de Kraken (0.40% taker) una vuelta completa cuesta 0.80%
 * mas el spread. El precio tiene que moverse casi un punto entero a favor solo
 * para empatar. Una estrategia que apunta a movimientos de medio punto pierde
 * plata aunque acierte la direccion todas las veces.
 */

export interface TradeCosts {
  /** Comision de entrada, en puntos basicos. */
  entryFeeBps: number;
  /** Comision de salida, en puntos basicos. */
  exitFeeBps: number;
  /** Costo de cruzar el spread al entrar y al salir. */
  spreadBps: number;
  /** Slippage asumido en ambas puntas. */
  slippageBps: number;
  /** Total de ida y vuelta: lo que el precio tiene que subir para empatar. */
  roundTripBps: number;
}

/** Costo de una vuelta completa (comprar y despues vender) al precio actual. */
export function roundTripCost(quote: Quote, cfg: Config): TradeCosts {
  const feeBps = cfg.FEE_RATE * 10_000;
  // El spread se paga una sola vez por vuelta: compramos en el ask y vendemos en
  // el bid, asi que la diferencia entre ambos se pierde una vez, no dos.
  const spread = spreadBps(quote);
  const slippage = cfg.PAPER_SLIPPAGE_BPS * 2;

  return {
    entryFeeBps: feeBps,
    exitFeeBps: feeBps,
    spreadBps: spread,
    slippageBps: slippage,
    roundTripBps: feeBps * 2 + spread + slippage,
  };
}

/**
 * Precio al que una posicion abierta queda en cero, ya contando la comision que
 * falta pagar al vender. Vender por debajo de esto es perder plata aunque el
 * precio este por encima del de entrada.
 */
export function breakevenPrice(entryPrice: number, cfg: Config): number {
  const fee = cfg.FEE_RATE;
  // Pagamos fee al comprar y volveremos a pagarlo al vender sobre el monto de venta.
  return (entryPrice * (1 + fee)) / (1 - fee);
}

/**
 * Costo en dolares de un ciclo de decision de Jev.
 *
 * Se cobra por token de entrada; la salida no se cobra. El estado mas las
 * preguntas dan alrededor de 1.000-1.200 tokens por ciclo, asi que esto ronda
 * los 5 centesimos de milesimo de dolar. Es despreciable frente a la comision
 * del exchange, pero lo contabilizamos igual para que el resultado neto sea el
 * verdadero y no una aproximacion optimista.
 */
export function jevCallCostUsd(inputTokens: number, pricePerMillion = 0.042): number {
  return (inputTokens / 1_000_000) * pricePerMillion;
}

export interface EdgeAssessment {
  /** Distancia hasta el objetivo, en puntos basicos. */
  targetBps: number;
  /** Costo de ida y vuelta, en puntos basicos. */
  costBps: number;
  /** Cuantas veces el objetivo cubre el costo. */
  edgeMultiple: number;
  /** Ganancia esperada neta de costos, en puntos basicos. */
  netBps: number;
  sufficient: boolean;
}

/**
 * Evalua si el movimiento al que apunta la operacion justifica su costo.
 *
 * No alcanza con que el objetivo supere el costo: hace falta margen, porque el
 * objetivo se alcanza solo una parte de las veces mientras que el costo se paga
 * siempre, incluidas las operaciones que terminan en el stop.
 */
export function assessEdge(
  entryPrice: number,
  targetPrice: number,
  quote: Quote,
  cfg: Config,
): EdgeAssessment {
  const costs = roundTripCost(quote, cfg);
  const targetBps = entryPrice > 0 ? ((targetPrice - entryPrice) / entryPrice) * 10_000 : 0;
  const costBps = costs.roundTripBps;

  return {
    targetBps,
    costBps,
    edgeMultiple: costBps > 0 ? targetBps / costBps : Number.POSITIVE_INFINITY,
    netBps: targetBps - costBps,
    sufficient: targetBps >= costBps * cfg.MIN_EDGE_MULTIPLE,
  };
}
