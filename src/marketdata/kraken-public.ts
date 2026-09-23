import type { Candle, PairRules, Quote } from "../types.js";

const BASE_URL = "https://api.kraken.com";

/** Respuesta generica de Kraken: los errores viajan en el body, no en el status HTTP. */
interface KrakenEnvelope<T> {
  error: string[];
  result: T;
}

export class KrakenApiError extends Error {
  constructor(
    message: string,
    readonly krakenErrors: string[] = [],
  ) {
    super(message);
    this.name = "KrakenApiError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Cliente de los endpoints publicos de Kraken: velas, cotizaciones y reglas del par.
 * No necesita credenciales, asi que funciona antes de que exista una cuenta.
 */
export class KrakenPublicClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl: string = BASE_URL,
  ) {}

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    const url = `${this.baseUrl}${path}?${qs}`;
    const res = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new KrakenApiError(`Kraken respondio HTTP ${res.status} en ${path}`);
    }
    const body = (await res.json()) as KrakenEnvelope<T>;
    // Kraken devuelve 200 con el error adentro del cuerpo: hay que mirarlo siempre.
    if (body.error?.length) {
      throw new KrakenApiError(`Kraken rechazo ${path}: ${body.error.join(", ")}`, body.error);
    }
    return body.result;
  }

  /**
   * Kraken normaliza el nombre del par en la respuesta (XBTUSD llega como XXBTZUSD),
   * asi que tomamos la primera clave que no sea metadata en vez de asumir el nombre.
   */
  private firstPairKey(result: Record<string, unknown>): string {
    const key = Object.keys(result).find((k) => k !== "last");
    if (!key) throw new KrakenApiError("Kraken devolvio un resultado sin datos del par");
    return key;
  }

  /** Velas OHLC. `interval` en minutos: 1, 5, 15, 30, 60, 240, 1440. */
  async getCandles(pair: string, intervalMin: number, since?: number): Promise<Candle[]> {
    const params: Record<string, string | number> = { pair, interval: intervalMin };
    if (since !== undefined) params.since = Math.floor(since / 1000);
    const result = await this.get<Record<string, unknown>>("/0/public/OHLC", params);
    const rows = result[this.firstPairKey(result)] as unknown[][];
    return rows.map((row) => ({
      // Kraken entrega el tiempo en segundos; adentro del bot todo es milisegundos.
      time: Number(row[0]) * 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[6]),
    }));
  }

  /** Mejor bid/ask y ultimo precio operado. */
  async getQuote(pair: string): Promise<Quote> {
    const result = await this.get<Record<string, unknown>>("/0/public/Ticker", { pair });
    const t = result[this.firstPairKey(result)] as { a: string[]; b: string[]; c: string[] };
    return {
      ask: Number(t.a[0]),
      bid: Number(t.b[0]),
      last: Number(t.c[0]),
      time: Date.now(),
    };
  }

  /** Decimales y minimos que el exchange exige para este par. */
  async getPairRules(pair: string): Promise<PairRules> {
    const result = await this.get<Record<string, unknown>>("/0/public/AssetPairs", { pair });
    const p = result[this.firstPairKey(result)] as {
      pair_decimals: number;
      lot_decimals: number;
      ordermin?: string;
      costmin?: string;
    };
    return {
      priceDecimals: p.pair_decimals,
      quantityDecimals: p.lot_decimals,
      minQuantity: p.ordermin ? Number(p.ordermin) : 0,
      minNotional: p.costmin ? Number(p.costmin) : 0,
    };
  }
}

/**
 * Descarga historia larga paginando hacia adelante con `since`.
 * Kraken corta en ~720 velas por pedido, asi que el backtest necesita varias vueltas.
 */
export async function fetchHistory(
  client: KrakenPublicClient,
  pair: string,
  intervalMin: number,
  fromMs: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = fromMs;
  for (let page = 0; page < 50; page++) {
    const batch = await client.getCandles(pair, intervalMin, cursor);
    const fresh = batch.filter((c) => c.time > (all.at(-1)?.time ?? -1));
    if (fresh.length === 0) break;
    all.push(...fresh);
    const newest = all.at(-1)!.time;
    if (newest <= cursor) break;
    cursor = newest;
    if (newest >= Date.now() - intervalMin * 60_000) break;
  }
  return all;
}
