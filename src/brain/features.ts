import {
  atr,
  bollinger,
  ema,
  highLow,
  last,
  macd,
  realizedVolPct,
  rsi,
  volumeZScore,
} from "../indicators/index.js";
import type { Candle, Position, Quote } from "../types.js";
import { spreadBps } from "../types.js";
import { pctChange, r } from "../util/num.js";

/**
 * Jev no ve pantallas, ni graficos, ni internet: solo recibe este objeto JSON.
 * Todo lo que necesite para decidir tiene que estar aca adentro, ya calculado y
 * redondeado. Este modulo es el unico puente entre el mercado y el modelo.
 */

export interface MarketFeatures {
  pair: string;
  timeframe: string;
  as_of: string;
  price: {
    last: number;
    spread_bps: number;
    change_1_candle_pct: number;
    change_4_candles_pct: number;
    change_24_candles_pct: number;
  };
  trend: {
    ema_fast: number | null;
    ema_slow: number | null;
    /** Distancia entre las dos EMAs en porcentaje. Positiva = tendencia alcista. */
    ema_gap_pct: number | null;
    price_vs_ema_slow_pct: number | null;
    ema_slow_slope_pct: number | null;
  };
  momentum: {
    rsi_14: number | null;
    /** Histograma MACD normalizado por el precio, para que sea comparable en el tiempo. */
    macd_histogram_pct: number | null;
    macd_histogram_rising: boolean | null;
  };
  volatility: {
    atr_pct: number | null;
    bollinger_width_pct: number | null;
    realized_vol_annualized_pct: number | null;
  };
  volume: {
    z_score: number | null;
  };
  levels: {
    distance_to_recent_high_pct: number | null;
    distance_to_recent_low_pct: number | null;
  };
  /** Las ultimas velas en crudo, por si el modelo lee algo que los indicadores no capturan. */
  recent_candles: { o: number; h: number; l: number; c: number; v: number }[];
}

export interface PortfolioFeatures {
  has_open_position: boolean;
  position_quantity: number;
  entry_price: number | null;
  unrealized_pnl_pct: number | null;
  hours_in_position: number | null;
  distance_to_stop_pct: number | null;
  distance_to_target_pct: number | null;
  cash_usd: number;
  equity_usd: number;
  exposure_pct: number;
}

export interface SessionFeatures {
  trades_today: number;
  realized_pnl_today_pct: number;
  consecutive_losses: number;
  minutes_since_last_trade: number | null;
  drawdown_from_peak_pct: number;
}

export interface DecisionState {
  market: MarketFeatures;
  portfolio: PortfolioFeatures;
  session: SessionFeatures;
}

export interface BuildFeaturesInput {
  pair: string;
  intervalMin: number;
  candles: Candle[];
  quote: Quote;
  position: Position | null;
  cash: number;
  baseQuantity: number;
  session: SessionFeatures;
}

/** Cuantas velas de este tamano entran en un ano, para anualizar la volatilidad. */
function candlesPerYear(intervalMin: number): number {
  return (365 * 24 * 60) / intervalMin;
}

function changeOver(closes: number[], lookback: number): number {
  if (closes.length <= lookback) return 0;
  return r(pctChange(closes[closes.length - 1 - lookback]!, closes.at(-1)!), 3);
}

export function buildMarketFeatures(input: BuildFeaturesInput): MarketFeatures {
  const { candles, quote, pair, intervalMin } = input;
  const closes = candles.map((c) => c.close);
  const price = quote.last;

  const emaFast = ema(closes, 12);
  const emaSlow = ema(closes, 26);
  const emaFastLast = last(emaFast);
  const emaSlowLast = last(emaSlow);

  // Pendiente de la EMA lenta comparando contra su valor 5 velas atras: distingue
  // una tendencia viva de un precio que solo cruzo la media de costado.
  let slope: number | null = null;
  const slowIdx = emaSlow.length - 1;
  const prevSlow = emaSlow[slowIdx - 5];
  if (emaSlowLast !== null && prevSlow !== null && prevSlow !== undefined) {
    slope = r(pctChange(prevSlow, emaSlowLast), 3);
  }

  const rsiLast = last(rsi(closes, 14));
  const macdRes = macd(closes);
  const histLast = last(macdRes.histogram);
  const histPrev = macdRes.histogram[macdRes.histogram.length - 2] ?? null;
  const atrLast = last(atr(candles, 14));
  const bb = last(bollinger(closes, 20, 2).widthPct);
  const hl = highLow(candles, 96);

  return {
    pair,
    timeframe: `${intervalMin}m`,
    as_of: new Date(quote.time).toISOString(),
    price: {
      last: r(price, 2),
      spread_bps: r(spreadBps(quote), 2),
      change_1_candle_pct: changeOver(closes, 1),
      change_4_candles_pct: changeOver(closes, 4),
      change_24_candles_pct: changeOver(closes, 24),
    },
    trend: {
      ema_fast: emaFastLast === null ? null : r(emaFastLast, 2),
      ema_slow: emaSlowLast === null ? null : r(emaSlowLast, 2),
      ema_gap_pct:
        emaFastLast !== null && emaSlowLast !== null
          ? r(pctChange(emaSlowLast, emaFastLast), 3)
          : null,
      price_vs_ema_slow_pct: emaSlowLast !== null ? r(pctChange(emaSlowLast, price), 3) : null,
      ema_slow_slope_pct: slope,
    },
    momentum: {
      rsi_14: rsiLast === null ? null : r(rsiLast, 2),
      macd_histogram_pct: histLast !== null && price > 0 ? r((histLast / price) * 100, 4) : null,
      macd_histogram_rising:
        histLast !== null && histPrev !== null && histPrev !== undefined
          ? histLast > histPrev
          : null,
    },
    volatility: {
      atr_pct: atrLast !== null && price > 0 ? r((atrLast / price) * 100, 3) : null,
      bollinger_width_pct: bb === null ? null : r(bb, 3),
      realized_vol_annualized_pct: (() => {
        const v = realizedVolPct(candles, 24, candlesPerYear(intervalMin));
        return v === null ? null : r(v, 2);
      })(),
    },
    volume: {
      z_score: (() => {
        const z = volumeZScore(candles, 20);
        return z === null ? null : r(z, 3);
      })(),
    },
    levels: {
      distance_to_recent_high_pct: hl ? r(pctChange(hl.high, price), 3) : null,
      distance_to_recent_low_pct: hl ? r(pctChange(hl.low, price), 3) : null,
    },
    recent_candles: candles.slice(-12).map((c) => ({
      o: r(c.open, 2),
      h: r(c.high, 2),
      l: r(c.low, 2),
      c: r(c.close, 2),
      v: r(c.volume, 3),
    })),
  };
}

export function buildPortfolioFeatures(input: BuildFeaturesInput): PortfolioFeatures {
  const { position, cash, baseQuantity, quote } = input;
  const price = quote.last;
  const equity = cash + baseQuantity * price;

  return {
    has_open_position: position !== null,
    position_quantity: position ? r(position.quantity, 8) : 0,
    entry_price: position ? r(position.entryPrice, 2) : null,
    unrealized_pnl_pct: position ? r(pctChange(position.entryPrice, price), 3) : null,
    hours_in_position: position ? r((Date.now() - position.entryTime) / 3_600_000, 2) : null,
    distance_to_stop_pct: position ? r(pctChange(price, position.stopPrice), 3) : null,
    distance_to_target_pct: position ? r(pctChange(price, position.targetPrice), 3) : null,
    cash_usd: r(cash, 2),
    equity_usd: r(equity, 2),
    exposure_pct: equity > 0 ? r(((baseQuantity * price) / equity) * 100, 2) : 0,
  };
}

export function buildDecisionState(input: BuildFeaturesInput): DecisionState {
  return {
    market: buildMarketFeatures(input),
    portfolio: buildPortfolioFeatures(input),
    session: input.session,
  };
}
