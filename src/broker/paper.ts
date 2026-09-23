import { randomUUID } from "node:crypto";
import type { Balance, Fill, PairRules, Quote, Side } from "../types.js";
import { roundTo } from "../util/num.js";
import { BrokerError, type Broker } from "./types.js";

export interface PaperBrokerOptions {
  startingCash: number;
  feeRate: number;
  slippageBps: number;
  rules: PairRules;
  /** Saldo inicial del activo base, si se retoma una corrida previa. */
  startingBase?: number;
}

/**
 * Simulador de ejecucion. Usa precios reales de mercado pero no manda nada al
 * exchange, asi que sirve para validar la estrategia entera sin una cuenta ni
 * plata. Cobra comision y aplica slippage para que el resultado no sea optimista:
 * un backtest sin costos siempre parece rentable.
 */
export class PaperBroker implements Broker {
  readonly name = "paper";
  readonly executesOrders = true;

  private cash: number;
  private base: number;

  constructor(private readonly opts: PaperBrokerOptions) {
    this.cash = opts.startingCash;
    this.base = opts.startingBase ?? 0;
  }

  async getBalance(): Promise<Balance> {
    return { cash: this.cash, base: this.base };
  }

  async getPairRules(): Promise<PairRules> {
    return this.opts.rules;
  }

  async placeMarketOrder(side: Side, quantity: number, reference: Quote): Promise<Fill> {
    if (quantity <= 0) throw new BrokerError(`Cantidad invalida: ${quantity}`);

    const slip = this.opts.slippageBps / 10_000;
    // Comprar cruza contra el ask y vender contra el bid; el slippage siempre
    // empeora el precio, nunca lo mejora.
    const price =
      side === "buy" ? reference.ask * (1 + slip) : reference.bid * (1 - slip);
    const notional = price * quantity;
    const fee = notional * this.opts.feeRate;

    if (side === "buy") {
      const total = notional + fee;
      if (total > this.cash + 1e-9) {
        throw new BrokerError(
          `Fondos insuficientes: la orden cuesta ${total.toFixed(2)} USD y hay ${this.cash.toFixed(2)}`,
        );
      }
      this.cash -= total;
      this.base += quantity;
    } else {
      if (quantity > this.base + 1e-9) {
        throw new BrokerError(
          `No hay tanto activo para vender: pedido ${quantity}, disponible ${this.base}`,
        );
      }
      this.base -= quantity;
      this.cash += notional - fee;
    }

    return {
      id: randomUUID(),
      side,
      quantity,
      price: roundTo(price, this.opts.rules.priceDecimals),
      fee: roundTo(fee, 2),
      time: Date.now(),
    };
  }

  /** Restaura saldos de una corrida anterior al reiniciar el proceso. */
  restore(cash: number, base: number): void {
    this.cash = cash;
    this.base = base;
  }
}
