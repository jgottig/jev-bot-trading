/** Tipos compartidos por todo el bot. */

/** Una vela OHLCV. `time` es epoch en milisegundos, al inicio de la vela. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Precio de mercado actual con las dos puntas del libro. */
export interface Quote {
  /** Mejor precio de compra del libro (lo que te pagan si vendes). */
  bid: number;
  /** Mejor precio de venta del libro (lo que pagas si compras). */
  ask: number;
  /** Precio de la ultima operacion ejecutada. */
  last: number;
  /** Epoch ms en que se obtuvo la cotizacion. */
  time: number;
}

/** Spread en puntos basicos (1 bp = 0.01%). */
export function spreadBps(q: Quote): number {
  const mid = (q.bid + q.ask) / 2;
  if (mid <= 0) return Number.POSITIVE_INFINITY;
  return ((q.ask - q.bid) / mid) * 10_000;
}

/** Precio medio entre ambas puntas. */
export function mid(q: Quote): number {
  return (q.bid + q.ask) / 2;
}

export type Side = "buy" | "sell";

/** Una orden ya ejecutada (o su simulacion en paper). */
export interface Fill {
  id: string;
  side: Side;
  /** Cantidad del activo base, ej. BTC. */
  quantity: number;
  /** Precio efectivo de ejecucion, ya con slippage aplicado. */
  price: number;
  /** Comision cobrada, en moneda de cotizacion (USD). */
  fee: number;
  time: number;
}

/** La posicion abierta. El bot es long/flat: nunca vende en corto. */
export interface Position {
  quantity: number;
  /** Precio promedio de entrada. */
  entryPrice: number;
  entryTime: number;
  /** Stop loss vigente, en precio absoluto. Se mueve con el trailing stop. */
  stopPrice: number;
  /** Take profit vigente, en precio absoluto. */
  targetPrice: number;
  /** Maximo precio alcanzado desde la entrada, para el trailing stop. */
  highWaterPrice: number;
}

/** Saldo de la cuenta. */
export interface Balance {
  /** Efectivo disponible en moneda de cotizacion (USD). */
  cash: number;
  /** Cantidad del activo base en cartera (BTC). */
  base: number;
}

/** Reglas del par que impone el exchange. */
export interface PairRules {
  /** Decimales permitidos en el precio. */
  priceDecimals: number;
  /** Decimales permitidos en la cantidad. */
  quantityDecimals: number;
  /** Cantidad minima negociable del activo base. */
  minQuantity: number;
  /** Valor minimo de la orden en moneda de cotizacion, si el exchange lo define. */
  minNotional: number;
}

/** Lo que el bot decide hacer en un ciclo. */
export type Action = "buy" | "sell" | "hold";

/** Motivo por el que se cerro una posicion. */
export type ExitReason =
  | "stop_loss"
  | "trailing_stop"
  | "take_profit"
  | "max_holding_time"
  | "model_exit"
  | "kill_switch"
  | "manual";
