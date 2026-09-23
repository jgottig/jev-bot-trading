import { describe, expect, it } from "vitest";
import { PaperBroker } from "../src/broker/paper.js";
import type { PairRules, Quote } from "../src/types.js";

const rules: PairRules = {
  priceDecimals: 1,
  quantityDecimals: 8,
  minQuantity: 0.0001,
  minNotional: 5,
};

const quote: Quote = { bid: 50000, ask: 50010, last: 50005, time: 0 };

function broker(startingCash = 1000, slippageBps = 0, feeRate = 0) {
  return new PaperBroker({ startingCash, feeRate, slippageBps, rules });
}

describe("PaperBroker", () => {
  it("compra contra el ask y descuenta efectivo mas comision", async () => {
    const b = broker(1000, 0, 0.0026);
    const fill = await b.placeMarketOrder("buy", 0.01, quote);

    expect(fill.price).toBe(50010);
    const notional = 50010 * 0.01; // 500.10
    expect(fill.fee).toBeCloseTo(notional * 0.0026, 2);

    const balance = await b.getBalance();
    expect(balance.base).toBeCloseTo(0.01, 10);
    expect(balance.cash).toBeCloseTo(1000 - notional - notional * 0.0026, 6);
  });

  it("vende contra el bid y suma efectivo neto de comision", async () => {
    const b = broker(1000, 0, 0.0026);
    await b.placeMarketOrder("buy", 0.01, quote);
    const before = (await b.getBalance()).cash;

    const fill = await b.placeMarketOrder("sell", 0.01, quote);
    expect(fill.price).toBe(50000);

    const balance = await b.getBalance();
    expect(balance.base).toBeCloseTo(0, 10);
    expect(balance.cash).toBeCloseTo(before + 50000 * 0.01 - 50000 * 0.01 * 0.0026, 6);
  });

  it("el slippage siempre empeora el precio, nunca lo mejora", async () => {
    const b = broker(100_000, 10); // 10 bps
    const buy = await b.placeMarketOrder("buy", 0.01, quote);
    const sell = await b.placeMarketOrder("sell", 0.01, quote);

    expect(buy.price).toBeGreaterThan(quote.ask);
    expect(sell.price).toBeLessThan(quote.bid);
  });

  it("no deja comprar mas de lo que alcanza el efectivo", async () => {
    const b = broker(100);
    await expect(b.placeMarketOrder("buy", 1, quote)).rejects.toThrow(/Fondos insuficientes/);
  });

  it("no deja vender lo que no se tiene: el bot es solo largo", async () => {
    const b = broker(1000);
    await expect(b.placeMarketOrder("sell", 0.5, quote)).rejects.toThrow(/No hay tanto activo/);
  });

  it("rechaza cantidades no positivas", async () => {
    const b = broker();
    await expect(b.placeMarketOrder("buy", 0, quote)).rejects.toThrow(/Cantidad invalida/);
    await expect(b.placeMarketOrder("buy", -1, quote)).rejects.toThrow(/Cantidad invalida/);
  });

  it("una vuelta completa sin movimiento de precio pierde exactamente spread mas comisiones", async () => {
    // Es la prueba de que el simulador no regala rentabilidad: comprar y vender
    // sin que el mercado se mueva tiene que dar perdida.
    const b = broker(1000, 0, 0.0026);
    await b.placeMarketOrder("buy", 0.01, quote);
    await b.placeMarketOrder("sell", 0.01, quote);
    const final = (await b.getBalance()).cash;

    expect(final).toBeLessThan(1000);
    const spreadCost = (50010 - 50000) * 0.01;
    const fees = 50010 * 0.01 * 0.0026 + 50000 * 0.01 * 0.0026;
    expect(1000 - final).toBeCloseTo(spreadCost + fees, 6);
  });

  it("restaura saldos de una corrida anterior", async () => {
    const b = broker(1000);
    b.restore(250, 0.03);
    expect(await b.getBalance()).toEqual({ cash: 250, base: 0.03 });
  });
});
