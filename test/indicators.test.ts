import { describe, expect, it } from "vitest";
import {
  atr,
  bollinger,
  ema,
  highLow,
  last,
  macd,
  realizedVolPct,
  rsi,
  sma,
  volumeZScore,
} from "../src/indicators/index.js";
import type { Candle } from "../src/types.js";

function candle(close: number, high = close, low = close, volume = 1): Candle {
  return { time: 0, open: close, high, low, close, volume };
}

describe("sma", () => {
  it("devuelve null hasta completar la ventana y luego el promedio", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("no calcula nada si la serie es mas corta que el periodo", () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe("ema", () => {
  it("se siembra con la SMA y despues aplica el factor de suavizado", () => {
    // periodo 3 -> k = 0.5. Semilla = SMA(1,2,3) = 2.
    // idx3 = 4*0.5 + 2*0.5 = 3 ; idx4 = 5*0.5 + 3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("converge al valor de una serie constante", () => {
    const result = last(ema(new Array(50).fill(100), 10));
    expect(result).toBeCloseTo(100, 6);
  });
});

describe("rsi", () => {
  it("da 100 cuando la serie solo sube: no hay perdidas en la ventana", () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(last(rsi(values, 14))).toBe(100);
  });

  it("da un valor bajo cuando la serie solo baja", () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(last(rsi(values, 14))).toBeCloseTo(0, 6);
  });

  it("da 50 en una serie plana, sin dividir por cero", () => {
    const values = new Array(30).fill(100);
    expect(last(rsi(values, 14))).toBe(50);
  });

  it("se mantiene entre 0 y 100 con datos ruidosos", () => {
    const values = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 10 + i * 0.1);
    for (const v of rsi(values, 14)) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe("atr", () => {
  it("iguala al rango cuando todas las velas tienen el mismo rango", () => {
    // Cierre constante en 100 con rango 4 en cada vela: el ATR tiene que dar 4.
    const candles = Array.from({ length: 40 }, () => candle(100, 102, 98));
    expect(last(atr(candles, 14))).toBeCloseTo(4, 6);
  });

  it("no produce resultado sin suficientes velas", () => {
    expect(last(atr([candle(100), candle(101)], 14))).toBeNull();
  });

  it("considera el hueco contra el cierre anterior, no solo high-low", () => {
    const candles: Candle[] = [candle(100, 100, 100)];
    // Vela que abre muy arriba: su rango verdadero se mide contra el cierre previo.
    for (let i = 0; i < 20; i++) candles.push(candle(120, 121, 119));
    const value = last(atr(candles, 14));
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(0);
  });
});

describe("macd", () => {
  it("da histograma positivo cuando la subida se acelera", () => {
    const values = Array.from({ length: 120 }, (_, i) => 100 + i * i * 0.05);
    expect(last(macd(values).histogram)!).toBeGreaterThan(0);
  });

  it("da histograma cero en una rampa lineal: el momentum es constante", () => {
    // Una recta sube siempre al mismo ritmo, asi que un oscilador de momentum
    // tiene que leer cero. Si diera positivo estaria inventando aceleracion.
    const values = Array.from({ length: 120 }, (_, i) => 100 + i * 2);
    expect(last(macd(values).histogram)!).toBeCloseTo(0, 9);
  });

  it("da histograma negativo cuando la subida se frena", () => {
    const values = Array.from({ length: 120 }, (_, i) => 100 + Math.sqrt(i) * 20);
    expect(last(macd(values).histogram)!).toBeLessThan(0);
  });

  it("alinea la senal y el histograma con el macd", () => {
    const values = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const res = macd(values);
    expect(res.macd.length).toBe(values.length);
    expect(res.signal.length).toBe(values.length);
    expect(res.histogram.length).toBe(values.length);
  });
});

describe("bollinger", () => {
  it("da ancho cero en una serie constante", () => {
    expect(last(bollinger(new Array(40).fill(100), 20, 2).widthPct)).toBeCloseTo(0, 9);
  });

  it("encierra al precio entre sus bandas", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 8);
    const bb = bollinger(values, 20, 2);
    const idx = values.length - 1;
    expect(bb.upper[idx]!).toBeGreaterThan(values[idx]!);
    expect(bb.lower[idx]!).toBeLessThan(values[idx]!);
  });
});

describe("realizedVolPct", () => {
  it("es cero cuando el precio no se mueve", () => {
    const candles = Array.from({ length: 40 }, () => candle(100));
    expect(realizedVolPct(candles, 24)).toBeCloseTo(0, 9);
  });

  it("crece cuando el precio se mueve mas", () => {
    const quiet = Array.from({ length: 40 }, (_, i) => candle(100 + (i % 2) * 0.1));
    const wild = Array.from({ length: 40 }, (_, i) => candle(100 + (i % 2) * 10));
    expect(realizedVolPct(wild, 24)!).toBeGreaterThan(realizedVolPct(quiet, 24)!);
  });
});

describe("volumeZScore", () => {
  it("marca un pico de volumen con z alto", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      candle(100, 100, 100, 10 + (i % 3)),
    );
    candles.push(candle(100, 100, 100, 100));
    expect(volumeZScore(candles, 20)!).toBeGreaterThan(3);
  });

  it("da cero si el volumen actual es igual al promedio sin dispersion", () => {
    const candles = Array.from({ length: 30 }, () => candle(100, 100, 100, 10));
    expect(volumeZScore(candles, 20)).toBe(0);
  });

  it("devuelve null ante un pico sin dispersion previa, en vez de fingir normalidad", () => {
    // Si devolviera 0 le estaria diciendo al modelo que un volumen 10 veces
    // mayor es corriente, que es el error mas caro posible en este indicador.
    const candles = Array.from({ length: 30 }, () => candle(100, 100, 100, 10));
    candles.push(candle(100, 100, 100, 100));
    expect(volumeZScore(candles, 20)).toBeNull();
  });
});

describe("highLow", () => {
  it("toma el maximo y el minimo de la ventana", () => {
    const candles = [candle(100, 110, 90), candle(101, 105, 95), candle(102, 120, 80)];
    expect(highLow(candles, 3)).toEqual({ high: 120, low: 80 });
  });
});

describe("last", () => {
  it("ignora los null del final", () => {
    expect(last([1, 2, null])).toBe(2);
  });
  it("devuelve null si no hay ningun valor", () => {
    expect(last([null, null])).toBeNull();
  });
});
