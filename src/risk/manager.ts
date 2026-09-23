import type { Config } from "../config.js";
import type { Candle, ExitReason, PairRules, Position, Quote } from "../types.js";
import { spreadBps } from "../types.js";
import { atr, last } from "../indicators/index.js";
import { floorTo } from "../util/num.js";
import { dailyPnlPct, drawdownPct, type BotState } from "../state/store.js";

/**
 * El gestor de riesgo es la unica parte del bot que el modelo no puede sobrepasar.
 *
 * Jev decide cuando entrar. Nada mas. Los stops, el tamano, los limites diarios y
 * el apagado de emergencia se evaluan antes de consultarlo y tienen prioridad
 * absoluta sobre lo que diga. Si el modelo alucina un "comprar" en medio de un
 * derrumbe, el corta-corriente ya lo freno.
 */

export interface HardExit {
  reason: ExitReason;
  detail: string;
}

/**
 * Salidas que se ejecutan sin preguntarle a nadie. Se evaluan en orden de
 * severidad: primero lo que limita la perdida, despues lo que toma la ganancia.
 */
export function checkHardExits(
  position: Position,
  quote: Quote,
  cfg: Config,
  now = Date.now(),
): HardExit | null {
  // Para salir vendemos contra el bid: ese es el precio que realmente vamos a recibir.
  const price = quote.bid;

  if (price <= position.stopPrice) {
    return {
      reason: position.stopPrice > position.entryPrice ? "trailing_stop" : "stop_loss",
      detail: `precio ${price.toFixed(2)} toco el stop ${position.stopPrice.toFixed(2)}`,
    };
  }
  if (price >= position.targetPrice) {
    return {
      reason: "take_profit",
      detail: `precio ${price.toFixed(2)} alcanzo el objetivo ${position.targetPrice.toFixed(2)}`,
    };
  }
  const hours = (now - position.entryTime) / 3_600_000;
  if (hours >= cfg.MAX_HOLDING_HOURS) {
    return {
      reason: "max_holding_time",
      detail: `${hours.toFixed(1)}h abierta, maximo ${cfg.MAX_HOLDING_HOURS}h`,
    };
  }
  return null;
}

/**
 * Sube el stop cuando el precio avanza, y nunca lo baja.
 * Devuelve la posicion actualizada.
 */
export function updateTrailingStop(position: Position, quote: Quote, cfg: Config): Position {
  const price = quote.bid;
  if (price <= position.highWaterPrice) return position;

  const candidate = price * (1 - cfg.TRAILING_STOP_PCT);
  return {
    ...position,
    highWaterPrice: price,
    // El stop solo puede subir: bajarlo seria ampliar la perdida maxima
    // despues de haber entrado, que es exactamente lo que arruina las cuentas.
    stopPrice: Math.max(position.stopPrice, candidate),
  };
}

/** Stop y objetivo iniciales, derivados de la volatilidad del momento. */
export function initialLevels(
  entryPrice: number,
  atrValue: number | null,
  cfg: Config,
): { stopPrice: number; targetPrice: number } {
  // Sin ATR (historia insuficiente) caemos al piso porcentual, que siempre existe.
  const atrStop = atrValue !== null ? entryPrice - cfg.STOP_ATR_MULT * atrValue : 0;
  const hardStop = entryPrice * (1 - cfg.HARD_STOP_PCT);
  // El stop mas cercano al precio de entrada es el que manda: arriesgamos lo menos
  // que indiquen las dos reglas, no lo mas.
  const stopPrice = Math.max(atrStop, hardStop);

  const target =
    atrValue !== null
      ? entryPrice + cfg.TAKE_PROFIT_ATR_MULT * atrValue
      : entryPrice * (1 + cfg.HARD_STOP_PCT * (cfg.TAKE_PROFIT_ATR_MULT / cfg.STOP_ATR_MULT));

  return { stopPrice, targetPrice: target };
}

export interface BreakerResult {
  blocked: boolean;
  /** true cuando hay que apagar el bot del todo, no solo frenar por hoy. */
  killSwitch: boolean;
  reason: string | null;
}

/**
 * Condiciones de apagado total, evaluadas aparte del resto de los frenos.
 *
 * Van separadas porque tienen que evaluarse en TODOS los ciclos, incluso en los
 * que una salida forzada corta el ciclo antes de llegar a los demas frenos. Si
 * se evaluaran solo al final, el estado guardado diria que el bot sigue operativo
 * durante el rato que va hasta el ciclo siguiente, que es justo cuando alguien
 * mira el tablero para entender que paso.
 */
export function checkKillSwitch(state: BotState, equity: number, cfg: Config): BreakerResult {
  if (state.killSwitch.active) {
    return {
      blocked: true,
      killSwitch: true,
      reason: `Corta-corriente activo: ${state.killSwitch.reason ?? "motivo no registrado"}`,
    };
  }
  const dd = drawdownPct(state, equity);
  if (dd >= cfg.MAX_DRAWDOWN_PCT * 100) {
    return {
      blocked: true,
      killSwitch: true,
      reason: `Drawdown ${dd.toFixed(2)}% supero el maximo ${(cfg.MAX_DRAWDOWN_PCT * 100).toFixed(2)}%`,
    };
  }
  return { blocked: false, killSwitch: false, reason: null };
}

/**
 * Frenos que impiden abrir nuevas posiciones.
 * Nunca impiden cerrar: salir siempre tiene que estar permitido.
 */
export function checkBreakers(
  state: BotState,
  equity: number,
  quote: Quote,
  cfg: Config,
  now = Date.now(),
): BreakerResult {
  const kill = checkKillSwitch(state, equity, cfg);
  if (kill.killSwitch) return kill;

  const daily = dailyPnlPct(state, equity);
  if (daily <= -cfg.DAILY_LOSS_LIMIT_PCT * 100) {
    return {
      blocked: true,
      killSwitch: false,
      reason: `Perdida del dia ${daily.toFixed(2)}% alcanzo el limite ${(cfg.DAILY_LOSS_LIMIT_PCT * 100).toFixed(2)}%`,
    };
  }

  if (state.tradesToday >= cfg.MAX_TRADES_PER_DAY) {
    return {
      blocked: true,
      killSwitch: false,
      reason: `Ya se hicieron ${state.tradesToday} operaciones hoy, el maximo es ${cfg.MAX_TRADES_PER_DAY}`,
    };
  }

  if (state.lastTradeTime !== null) {
    const minutes = (now - state.lastTradeTime) / 60_000;
    if (minutes < cfg.COOLDOWN_MIN) {
      return {
        blocked: true,
        killSwitch: false,
        reason: `En enfriamiento: faltan ${(cfg.COOLDOWN_MIN - minutes).toFixed(1)} minutos`,
      };
    }
  }

  const spread = spreadBps(quote);
  if (spread > cfg.MAX_SPREAD_BPS) {
    return {
      blocked: true,
      killSwitch: false,
      reason: `Spread ${spread.toFixed(2)}bps por encima del maximo ${cfg.MAX_SPREAD_BPS}bps`,
    };
  }

  return { blocked: false, killSwitch: false, reason: null };
}

export interface SizingInput {
  equity: number;
  cash: number;
  quote: Quote;
  candles: Candle[];
  rules: PairRules;
  /** Fraccion del tamano maximo que pidio la politica, entre 0 y 1. */
  sizeFraction: number;
  cfg: Config;
}

export interface SizingResult {
  quantity: number;
  notional: number;
  rejected: string | null;
}

/**
 * Calcula cuanto comprar.
 *
 * El tamano sale del limite de exposicion, de la conviccion del modelo y del
 * riesgo por operacion: nunca arriesgamos mas que HARD_STOP_PCT del equity en un
 * solo trade, asi que una posicion con el stop lejos entra mas chica.
 */
export function computeBuyQuantity(input: SizingInput): SizingResult {
  const { equity, cash, quote, candles, rules, sizeFraction, cfg } = input;
  const price = quote.ask;
  if (price <= 0) return { quantity: 0, notional: 0, rejected: "precio invalido" };

  // Techo 1: exposicion maxima permitida, escalada por la conviccion.
  const byExposure = equity * cfg.MAX_POSITION_PCT * sizeFraction;

  // Techo 2: riesgo por operacion. Si el stop queda a X% del precio y aceptamos
  // perder como mucho RISK_PER_TRADE_PCT del equity, la posicion no puede pasar
  // de (riesgo maximo / X). Este es el ajuste por volatilidad: cuando el ATR
  // crece, el stop se aleja, X sube y la posicion entra proporcionalmente mas
  // chica. Por eso RISK_PER_TRADE_PCT tiene que ser menor que HARD_STOP_PCT: si
  // fueran iguales, este techo daria siempre el equity entero y no limitaria nada.
  const atrValue = last(atr(candles, 14));
  const { stopPrice } = initialLevels(price, atrValue, cfg);
  const stopDistancePct = (price - stopPrice) / price;
  const maxRiskUsd = equity * cfg.RISK_PER_TRADE_PCT;
  const byRisk = stopDistancePct > 0 ? maxRiskUsd / stopDistancePct : byExposure;

  // Techo 3: el efectivo disponible, dejando margen para la comision.
  const byCash = cash / (1 + cfg.FEE_RATE);

  const notional = Math.min(byExposure, byRisk, byCash);
  const quantity = floorTo(notional / price, rules.quantityDecimals);
  const actualNotional = quantity * price;

  if (quantity <= 0) {
    return { quantity: 0, notional: 0, rejected: "la cantidad redondeada da cero" };
  }
  if (quantity < rules.minQuantity) {
    return {
      quantity: 0,
      notional: actualNotional,
      rejected: `cantidad ${quantity} por debajo del minimo del par ${rules.minQuantity}`,
    };
  }
  if (actualNotional < cfg.MIN_ORDER_USD) {
    return {
      quantity: 0,
      notional: actualNotional,
      rejected: `orden de ${actualNotional.toFixed(2)} USD por debajo del minimo ${cfg.MIN_ORDER_USD} USD`,
    };
  }
  if (rules.minNotional > 0 && actualNotional < rules.minNotional) {
    return {
      quantity: 0,
      notional: actualNotional,
      rejected: `orden de ${actualNotional.toFixed(2)} USD por debajo del minimo del exchange ${rules.minNotional}`,
    };
  }

  return { quantity, notional: actualNotional, rejected: null };
}
