import { describe, expect, it, vi } from "vitest";
import { KrakenBroker, signRequest } from "../src/broker/kraken.js";
import { KrakenApiError, KrakenPublicClient } from "../src/marketdata/kraken-public.js";
import type { Quote } from "../src/types.js";

/** Respuesta JSON falsa con la forma que usa Kraken. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ASSET_PAIRS = {
  error: [],
  result: {
    XXBTZUSD: {
      base: "XXBT",
      quote: "ZUSD",
      pair_decimals: 1,
      lot_decimals: 8,
      ordermin: "0.0001",
      costmin: "5",
    },
  },
};

describe("signRequest", () => {
  it("reproduce el vector de prueba publicado por Kraken", () => {
    // Si este test se rompe, ninguna llamada privada va a autenticar.
    const signature = signRequest(
      "/0/private/AddOrder",
      "1616492376594",
      "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25",
      "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==",
    );
    expect(signature).toBe(
      "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==",
    );
  });

  it("cambia la firma si cambia cualquier parte del mensaje", () => {
    const base = signRequest("/0/private/Balance", "1", "nonce=1", "c2VjcmV0");
    expect(signRequest("/0/private/AddOrder", "1", "nonce=1", "c2VjcmV0")).not.toBe(base);
    expect(signRequest("/0/private/Balance", "2", "nonce=2", "c2VjcmV0")).not.toBe(base);
  });
});

describe("KrakenPublicClient", () => {
  it("convierte las velas a milisegundos y toma el volumen de la columna correcta", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        error: [],
        result: {
          // [time, open, high, low, close, vwap, volume, count]
          XXBTZUSD: [["1700000000", "100.1", "102.5", "99.0", "101.2", "100.8", "12.5", 42]],
          last: 1700000000,
        },
      }),
    );
    const client = new KrakenPublicClient(fetchMock);
    const candles = await client.getCandles("XBTUSD", 15);

    expect(candles).toHaveLength(1);
    expect(candles[0]).toEqual({
      time: 1700000000000,
      open: 100.1,
      high: 102.5,
      low: 99.0,
      close: 101.2,
      volume: 12.5,
    });
  });

  it("lee el par aunque Kraken le cambie el nombre en la respuesta", async () => {
    // Pedimos XBTUSD y Kraken contesta bajo la clave XXBTZUSD.
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        error: [],
        result: { XXBTZUSD: { a: ["50100.5", "1", "1"], b: ["50099.5", "2", "2"], c: ["50100.0", "0.1"] } },
      }),
    );
    const quote = await new KrakenPublicClient(fetchMock).getQuote("XBTUSD");
    expect(quote.ask).toBe(50100.5);
    expect(quote.bid).toBe(50099.5);
    expect(quote.last).toBe(50100.0);
  });

  it("lanza error cuando Kraken devuelve el fallo dentro del cuerpo con HTTP 200", async () => {
    // Kraken responde 200 aunque haya error: si no miramos el campo `error`,
    // seguiriamos adelante con un resultado vacio.
    const fetchMock = vi.fn(async () => jsonResponse({ error: ["EQuery:Unknown asset pair"], result: {} }));
    await expect(new KrakenPublicClient(fetchMock).getQuote("NOPE")).rejects.toThrow(KrakenApiError);
  });

  it("lee decimales y minimos del par", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ASSET_PAIRS));
    const rules = await new KrakenPublicClient(fetchMock).getPairRules("XBTUSD");
    expect(rules).toEqual({
      priceDecimals: 1,
      quantityDecimals: 8,
      minQuantity: 0.0001,
      minNotional: 5,
    });
  });
});

describe("KrakenBroker", () => {
  const quote: Quote = { bid: 50000, ask: 50010, last: 50005, time: Date.now() };

  function brokerWith(handler: (url: string, init?: RequestInit) => Response, dryRun = false) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
    return {
      fetchMock,
      broker: new KrakenBroker({
        apiKey: "test-key",
        apiSecret: "c2VjcmV0LWJhc2U2NC1oZXJl",
        pair: "XBTUSD",
        dryRun,
        fetchImpl: fetchMock,
        sleep: async () => {},
      }),
    };
  }

  it("manda las tres cabeceras de autenticacion en las llamadas privadas", async () => {
    const { fetchMock, broker } = brokerWith((url) => {
      if (url.includes("AssetPairs")) return jsonResponse(ASSET_PAIRS);
      return jsonResponse({ error: [], result: { ZUSD: "1500.00", XXBT: "0.05" } });
    });

    const balance = await broker.getBalance();
    expect(balance).toEqual({ cash: 1500, base: 0.05 });

    const privateCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/0/private/"));
    const headers = privateCall?.[1]?.headers as Record<string, string>;
    expect(headers["API-Key"]).toBe("test-key");
    expect(headers["API-Sign"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(String(privateCall?.[1]?.body)).toContain("nonce=");
  });

  it("usa un nonce estrictamente creciente entre llamadas seguidas", async () => {
    const nonces: number[] = [];
    const { broker } = brokerWith((url, init) => {
      if (url.includes("AssetPairs")) return jsonResponse(ASSET_PAIRS);
      const body = new URLSearchParams(String(init?.body));
      nonces.push(Number(body.get("nonce")));
      return jsonResponse({ error: [], result: { ZUSD: "100", XXBT: "0" } });
    });

    await broker.getBalance();
    await broker.getBalance();
    await broker.getBalance();

    expect(nonces).toHaveLength(3);
    for (let i = 1; i < nonces.length; i++) {
      expect(nonces[i]!).toBeGreaterThan(nonces[i - 1]!);
    }
  });

  it("informa el precio y la comision reales de la ejecucion, no los estimados", async () => {
    const { broker } = brokerWith((url) => {
      if (url.includes("AssetPairs")) return jsonResponse(ASSET_PAIRS);
      if (url.includes("QueryOrders")) {
        return jsonResponse({
          error: [],
          result: {
            TX123: {
              status: "closed",
              vol: "0.01",
              vol_exec: "0.01",
              cost: "501.23",
              fee: "1.30",
              price: "50123.00",
            },
          },
        });
      }
      return jsonResponse({ error: [], result: { txid: ["TX123"], descr: { order: "buy" } } });
    });

    const fill = await broker.placeMarketOrder("buy", 0.01, quote);
    // El precio efectivo (50123) difiere del ask estimado (50010): usamos el real.
    expect(fill.price).toBe(50123);
    expect(fill.fee).toBe(1.3);
    expect(fill.quantity).toBe(0.01);
    expect(fill.id).toBe("TX123");
  });

  it("contabiliza una ejecucion parcial por lo que efectivamente se lleno", async () => {
    const { broker } = brokerWith((url) => {
      if (url.includes("AssetPairs")) return jsonResponse(ASSET_PAIRS);
      if (url.includes("QueryOrders")) {
        return jsonResponse({
          error: [],
          result: {
            TX9: { status: "canceled", vol: "0.01", vol_exec: "0.004", cost: "200", fee: "0.5", price: "50000" },
          },
        });
      }
      return jsonResponse({ error: [], result: { txid: ["TX9"] } });
    });

    const fill = await broker.placeMarketOrder("buy", 0.01, quote);
    expect(fill.quantity).toBe(0.004);
  });

  it("falla si la orden se cancela sin ejecutar nada", async () => {
    const { broker } = brokerWith((url) => {
      if (url.includes("AssetPairs")) return jsonResponse(ASSET_PAIRS);
      if (url.includes("QueryOrders")) {
        return jsonResponse({
          error: [],
          result: {
            TX0: { status: "canceled", vol: "0.01", vol_exec: "0", cost: "0", fee: "0", price: "0" },
          },
        });
      }
      return jsonResponse({ error: [], result: { txid: ["TX0"] } });
    });

    await expect(broker.placeMarketOrder("buy", 0.01, quote)).rejects.toThrow(/sin ejecutar/);
  });

  it("en dry run manda validate=true y no consulta la ejecucion", async () => {
    const bodies: string[] = [];
    const urls: string[] = [];
    const { broker } = brokerWith((url, init) => {
      urls.push(url);
      if (url.includes("AssetPairs")) return jsonResponse(ASSET_PAIRS);
      bodies.push(String(init?.body));
      return jsonResponse({ error: [], result: { descr: { order: "buy 0.01 XBTUSD @ market" } } });
    }, true);

    const fill = await broker.placeMarketOrder("buy", 0.01, quote);
    expect(bodies[0]).toContain("validate=true");
    expect(urls.some((u) => u.includes("QueryOrders"))).toBe(false);
    expect(fill.id).toMatch(/^dryrun-/);
    expect(broker.executesOrders).toBe(false);
  });

  it("propaga el error que Kraken devuelve dentro del cuerpo", async () => {
    const { broker } = brokerWith((url) => {
      if (url.includes("AssetPairs")) return jsonResponse(ASSET_PAIRS);
      return jsonResponse({ error: ["EOrder:Insufficient funds"], result: {} });
    });
    await expect(broker.placeMarketOrder("buy", 0.01, quote)).rejects.toThrow(/Insufficient funds/);
  });

  it("rechaza cantidades no positivas antes de llamar al exchange", async () => {
    const { broker, fetchMock } = brokerWith(() => jsonResponse(ASSET_PAIRS));
    await expect(broker.placeMarketOrder("buy", 0, quote)).rejects.toThrow(/Cantidad invalida/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
