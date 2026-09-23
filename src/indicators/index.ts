import type { Candle } from "../types.js";

/**
 * Indicadores tecnicos.
 *
 * Todas las funciones devuelven una serie de la misma longitud que la entrada,
 * con `null` en las posiciones donde el indicador todavia no tiene suficientes
 * datos para calcularse. Nunca devolvemos NaN: un NaN se propaga en silencio
 * por toda la cuenta y termina en una orden con cantidad invalida, mientras que
 * un `null` rompe fuerte y temprano.
 */
export type Series = (number | null)[];

/** Ultimo valor no nulo de una serie, o null si no hay ninguno. */
export function last(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/** Media movil simple. */
export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Media movil exponencial, sembrada con la SMA de los primeros `period` valores.
 * Sembrar con SMA en lugar del primer precio evita que el arranque de la serie
 * distorsione los primeros cientos de valores.
 */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * RSI con suavizado de Wilder (el original, no una EMA comun).
 * Devuelve valores de 0 a 100.
 */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  // Sin perdidas en la ventana el RSI es 100 por definicion; evita dividir por cero.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Rango verdadero de una vela respecto del cierre anterior. */
function trueRange(c: Candle, prevClose: number): number {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

/** Average True Range con suavizado de Wilder. Mide volatilidad en precio absoluto. */
export function atr(candles: Candle[], period = 14): Series {
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trueRange(candles[i]!, candles[i - 1]!.close);
  }
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < candles.length; i++) {
    const tr = trueRange(candles[i]!, candles[i - 1]!.close);
    prev = (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

export interface Macd {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/** MACD clasico: EMA rapida menos EMA lenta, y su linea de senal. */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: Series = values.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f !== null && f !== undefined && s !== null && s !== undefined ? f - s : null;
  });

  // La linea de senal es una EMA del MACD, que solo existe desde que el MACD existe.
  const firstIdx = macdLine.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  const histogram: Series = new Array(values.length).fill(null);
  if (firstIdx === -1) return { macd: macdLine, signal, histogram };

  const compact = macdLine.slice(firstIdx).map((v) => v ?? 0);
  const sig = ema(compact, signalPeriod);
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i];
    if (v === null || v === undefined) continue;
    const abs = firstIdx + i;
    signal[abs] = v;
    const m = macdLine[abs];
    if (m !== null && m !== undefined) histogram[abs] = m - v;
  }
  return { macd: macdLine, signal, histogram };
}

export interface Bollinger {
  middle: Series;
  upper: Series;
  lower: Series;
  /** Ancho de las bandas como porcentaje de la media. Mide compresion/expansion. */
  widthPct: Series;
}

/** Bandas de Bollinger. */
export function bollinger(values: number[], period = 20, stdDevs = 2): Bollinger {
  const middle = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  const widthPct: Series = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    const m = middle[i];
    if (m === null || m === undefined) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j]! - m;
      acc += d * d;
    }
    const sd = Math.sqrt(acc / period);
    upper[i] = m + stdDevs * sd;
    lower[i] = m - stdDevs * sd;
    widthPct[i] = m !== 0 ? ((2 * stdDevs * sd) / m) * 100 : null;
  }
  return { middle, upper, lower, widthPct };
}

/**
 * Volatilidad realizada: desvio estandar de los retornos logaritmicos de la
 * ventana, anualizado segun cuantas velas entran en un ano.
 */
export function realizedVolPct(candles: Candle[], period = 24, candlesPerYear = 35_040): number | null {
  if (candles.length < period + 1) return null;
  const rets: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const cur = candles[i]!.close;
    if (prev <= 0 || cur <= 0) continue;
    rets.push(Math.log(cur / prev));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(candlesPerYear) * 100;
}

/**
 * Z-score del volumen de la ultima vela contra su ventana.
 * Sirve para distinguir un movimiento con participacion real de uno sin nadie.
 */
export function volumeZScore(candles: Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const window = candles.slice(-period - 1, -1).map((c) => c.volume);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
  const sd = Math.sqrt(variance);
  const current = candles[candles.length - 1]!.volume;
  if (sd === 0) {
    // Sin dispersion previa el z-score no esta definido. Devolver 0 seria decir
    // "volumen normal" justo cuando aparece el primer pico, que es el caso que
    // mas importa detectar; `null` declara honestamente que no se puede medir.
    return current === mean ? 0 : null;
  }
  return (current - mean) / sd;
}

/** Maximo y minimo de cierre de las ultimas `period` velas. */
export function highLow(candles: Candle[], period: number): { high: number; low: number } | null {
  if (candles.length < period) return null;
  const window = candles.slice(-period);
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
  };
}
