import type { Balance, Fill, PairRules, Quote, Side } from "../types.js";

/**
 * Un broker sabe cuanto tenemos y sabe ejecutar ordenes a mercado.
 * El motor no conoce Kraken: conoce esta interfaz. Cambiar de exchange es
 * escribir otra implementacion, sin tocar la estrategia ni el riesgo.
 */
export interface Broker {
  /** Nombre para los logs: "paper", "kraken", "kraken-dryrun". */
  readonly name: string;
  /** false cuando las ordenes se validan pero no se ejecutan (dry run). */
  readonly executesOrders: boolean;

  getBalance(): Promise<Balance>;
  getPairRules(): Promise<PairRules>;

  /**
   * Ejecuta una orden a mercado.
   * @param quantity cantidad del activo base (BTC), ya redondeada a los decimales del par.
   * @param reference cotizacion usada para estimar el precio y controlar slippage.
   */
  placeMarketOrder(side: Side, quantity: number, reference: Quote): Promise<Fill>;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
