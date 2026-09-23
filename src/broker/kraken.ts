import crypto from "node:crypto";
import type { Balance, Fill, PairRules, Quote, Side } from "../types.js";
import { fixed } from "../util/num.js";
import { BrokerError, type Broker } from "./types.js";

const BASE_URL = "https://api.kraken.com";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Firma de Kraken para endpoints privados.
 *
 * API-Sign = base64( HMAC-SHA512( uriPath || SHA256(nonce || postdata), base64decode(secret) ) )
 *
 * Los dos puntos donde suele fallar: el secreto va decodificado de base64 (no como
 * texto) y el SHA256 se concatena como bytes crudos al path, no como hexadecimal.
 */
export function signRequest(
  uriPath: string,
  nonce: string,
  postdata: string,
  apiSecret: string,
): string {
  const hashed = crypto.createHash("sha256").update(nonce + postdata).digest();
  const message = Buffer.concat([Buffer.from(uriPath, "utf8"), hashed]);
  return crypto
    .createHmac("sha512", Buffer.from(apiSecret, "base64"))
    .update(message)
    .digest("base64");
}

interface KrakenEnvelope<T> {
  error: string[];
  result: T;
}

interface OrderInfo {
  status: string;
  vol: string;
  vol_exec: string;
  cost: string;
  fee: string;
  price: string;
}

export interface KrakenBrokerOptions {
  apiKey: string;
  apiSecret: string;
  pair: string;
  /** true = manda validate=true y el exchange valida sin ejecutar. */
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Inyectable en tests para no esperar de verdad entre reintentos. */
  sleep?: (ms: number) => Promise<void>;
}

/** Broker real contra Kraken. Solo opera spot al contado: nunca vende en corto ni usa margen. */
export class KrakenBroker implements Broker {
  readonly name: string;
  readonly executesOrders: boolean;

  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastNonce = 0;
  private cachedPair: {
    rules: PairRules;
    baseAsset: string;
    quoteAsset: string;
    krakenName: string;
  } | null = null;

  constructor(private readonly opts: KrakenBrokerOptions) {
    this.name = opts.dryRun ? "kraken-dryrun" : "kraken";
    this.executesOrders = !opts.dryRun;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * El nonce tiene que crecer estrictamente en cada llamada. Usamos microsegundos
   * y forzamos el incremento porque dos pedidos en el mismo milisegundo darian el
   * mismo valor y Kraken rechazaria el segundo.
   */
  private nextNonce(): string {
    const now = Date.now() * 1000;
    this.lastNonce = now > this.lastNonce ? now : this.lastNonce + 1;
    return String(this.lastNonce);
  }

  private async privatePost<T>(method: string, params: Record<string, string> = {}): Promise<T> {
    const path = `/0/private/${method}`;
    const nonce = this.nextNonce();
    const body = new URLSearchParams({ nonce, ...params }).toString();
    const signature = signRequest(path, nonce, body, this.opts.apiSecret);

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "API-Key": this.opts.apiKey,
        "API-Sign": signature,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    if (!res.ok) {
      throw new BrokerError(`Kraken respondio HTTP ${res.status} en ${method}`);
    }
    const envelope = (await res.json()) as KrakenEnvelope<T>;
    if (envelope.error?.length) {
      throw new BrokerError(`Kraken rechazo ${method}: ${envelope.error.join(", ")}`);
    }
    return envelope.result;
  }

  private async publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const res = await this.fetchImpl(`${this.baseUrl}${path}?${qs}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new BrokerError(`Kraken respondio HTTP ${res.status} en ${path}`);
    const envelope = (await res.json()) as KrakenEnvelope<T>;
    if (envelope.error?.length) {
      throw new BrokerError(`Kraken rechazo ${path}: ${envelope.error.join(", ")}`);
    }
    return envelope.result;
  }

  /** Lee del exchange los decimales y minimos del par, y como se llaman sus dos activos. */
  private async loadPair(): Promise<NonNullable<typeof this.cachedPair>> {
    if (this.cachedPair) return this.cachedPair;
    const result = await this.publicGet<Record<string, unknown>>("/0/public/AssetPairs", {
      pair: this.opts.pair,
    });
    const krakenName = Object.keys(result)[0];
    if (!krakenName) throw new BrokerError(`Kraken no conoce el par ${this.opts.pair}`);
    const p = result[krakenName] as {
      base: string;
      quote: string;
      pair_decimals: number;
      lot_decimals: number;
      ordermin?: string;
      costmin?: string;
    };
    this.cachedPair = {
      krakenName,
      baseAsset: p.base,
      quoteAsset: p.quote,
      rules: {
        priceDecimals: p.pair_decimals,
        quantityDecimals: p.lot_decimals,
        minQuantity: p.ordermin ? Number(p.ordermin) : 0,
        minNotional: p.costmin ? Number(p.costmin) : 0,
      },
    };
    return this.cachedPair;
  }

  async getPairRules(): Promise<PairRules> {
    return (await this.loadPair()).rules;
  }

  async getBalance(): Promise<Balance> {
    const { baseAsset, quoteAsset } = await this.loadPair();
    const balances = await this.privatePost<Record<string, string>>("Balance");
    return {
      cash: Number(balances[quoteAsset] ?? 0),
      base: Number(balances[baseAsset] ?? 0),
    };
  }

  async placeMarketOrder(side: Side, quantity: number, reference: Quote): Promise<Fill> {
    if (quantity <= 0) throw new BrokerError(`Cantidad invalida: ${quantity}`);
    const { rules } = await this.loadPair();

    const params: Record<string, string> = {
      pair: this.opts.pair,
      type: side,
      ordertype: "market",
      volume: fixed(quantity, rules.quantityDecimals),
    };
    // validate=true hace que Kraken corra todas sus validaciones (saldo, minimos,
    // decimales) y devuelva el resultado sin tocar el mercado.
    if (this.opts.dryRun) params.validate = "true";

    const result = await this.privatePost<{ txid?: string[]; descr?: { order?: string } }>(
      "AddOrder",
      params,
    );

    if (this.opts.dryRun) {
      const price = side === "buy" ? reference.ask : reference.bid;
      return {
        id: `dryrun-${Date.now()}`,
        side,
        quantity,
        price,
        fee: 0,
        time: Date.now(),
      };
    }

    const txid = result.txid?.[0];
    if (!txid) throw new BrokerError("Kraken acepto la orden pero no devolvio txid");
    return this.waitForFill(txid, side, reference);
  }

  /**
   * Una orden a mercado no queda ejecutada en el instante en que Kraken la acepta.
   * Consultamos el precio y la comision reales en vez de asumir los de la cotizacion:
   * la contabilidad tiene que reflejar lo que de verdad paso.
   */
  private async waitForFill(txid: string, side: Side, reference: Quote): Promise<Fill> {
    const delays = [300, 700, 1500, 3000, 5000];
    let info: OrderInfo | undefined;

    for (const delay of delays) {
      await this.sleep(delay);
      const orders = await this.privatePost<Record<string, OrderInfo>>("QueryOrders", { txid });
      info = orders[txid];
      if (!info) continue;
      if (info.status === "closed") break;
      if (info.status === "canceled" || info.status === "expired") {
        const executed = Number(info.vol_exec);
        if (executed <= 0) {
          throw new BrokerError(`Kraken ${info.status} la orden ${txid} sin ejecutar nada`);
        }
        break; // Ejecucion parcial: la contabilizamos por lo que si se lleno.
      }
    }

    if (!info) throw new BrokerError(`No se pudo consultar el estado de la orden ${txid}`);

    const executed = Number(info.vol_exec);
    if (executed <= 0) {
      throw new BrokerError(
        `La orden ${txid} sigue en estado "${info.status}" sin ejecucion. Revisala en Kraken antes de seguir.`,
      );
    }

    const cost = Number(info.cost);
    const fee = Number(info.fee);
    // Kraken informa `price` como promedio ponderado; si viniera en cero lo derivamos
    // del costo total, y solo como ultimo recurso usamos la cotizacion de referencia.
    const avgPrice =
      Number(info.price) > 0
        ? Number(info.price)
        : executed > 0 && cost > 0
          ? cost / executed
          : side === "buy"
            ? reference.ask
            : reference.bid;

    return {
      id: txid,
      side,
      quantity: executed,
      price: avgPrice,
      fee,
      time: Date.now(),
    };
  }

  /** Comprueba que la clave funciona y tiene permisos de lectura. */
  async ping(): Promise<Balance> {
    return this.getBalance();
  }
}
