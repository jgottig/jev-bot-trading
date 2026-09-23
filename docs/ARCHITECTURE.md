# Arquitectura

## El ciclo

Cada `LOOP_INTERVAL_SEC` segundos (300 por defecto) corre `TradingEngine.runOnce()`:

```
  ┌─ 1. Datos ──────────────────────────────────────────────┐
  │  Kraken publico: velas OHLC + mejor bid/ask              │
  │  Broker: saldo y reglas del par                          │
  └──────────────────────────────────────────────────────────┘
                              ↓
  ┌─ 2. Corta-corriente ─────────────────────────────────────┐
  │  ¿Drawdown desde el pico >= MAX_DRAWDOWN_PCT?            │
  │  Se evalua siempre, aunque el ciclo corte mas abajo.      │
  └──────────────────────────────────────────────────────────┘
                              ↓
  ┌─ 3. Salidas duras ───────────── SIN CONSULTAR AL MODELO ─┐
  │  stop loss · trailing stop · objetivo · tiempo maximo     │
  │  Si salta alguna: vender y terminar el ciclo.             │
  └──────────────────────────────────────────────────────────┘
                              ↓
  ┌─ 4. Frenos ──────────────────────────────────────────────┐
  │  perdida diaria · tope de operaciones · enfriamiento      │
  │  spread demasiado abierto                                 │
  │  Bloquean ENTRADAS. Nunca bloquean salidas.               │
  └──────────────────────────────────────────────────────────┘
                              ↓
  ┌─ 5. Features ────────────────────────────────────────────┐
  │  EMA · RSI · ATR · MACD · Bollinger · volumen z-score     │
  │  + cartera + sesion  →  un unico objeto JSON              │
  └──────────────────────────────────────────────────────────┘
                              ↓
  ┌─ 6. Jev ─────────────────────────────────────────────────┐
  │  5 preguntas tipadas → probabilidades y confianza         │
  └──────────────────────────────────────────────────────────┘
                              ↓
  ┌─ 7. Politica ────────────────────────────────────────────┐
  │  ¿Las probabilidades superan los umbrales del .env?       │
  └──────────────────────────────────────────────────────────┘
                              ↓
  ┌─ 8. Tamano ──────────────────────────────────────────────┐
  │  min(exposicion maxima, riesgo por operacion, efectivo)   │
  └──────────────────────────────────────────────────────────┘
                              ↓
  ┌─ 9. Ejecutar y persistir ────────────────────────────────┐
  │  Orden a mercado → estado a disco (escritura atomica)     │
  └──────────────────────────────────────────────────────────┘
```

Los pasos 2, 3, 4 y 8 son codigo deterministico y tienen prioridad sobre el
modelo. Jev solo influye en los pasos 6 y 7, y solo puede hacer que el bot
**opere menos**, nunca que se salte una proteccion.

## Decisiones de diseno

### Por que las preguntas estan en ingles

TypeSafe documenta que Jev esta calibrado principalmente en ingles y recomienda
medir aparte cualquier carga en otro idioma. Las preguntas viven en
`src/brain/jev.ts` en ingles por calidad de salida, no por estetica. Todo lo
demas del proyecto esta en castellano.

### Por que los indicadores se calculan en codigo y no los "piensa" el modelo

Jev evalua un estado; no calcula. Ademas, un indicador calculado en TypeScript es
reproducible, testeable y gratis. Pedirle a un modelo que calcule un RSI seria
caro, lento y no deterministico.

### Por que la politica esta separada del modelo

Si los umbrales vivieran adentro del prompt, una version nueva de Jev cambiaria
el comportamiento del bot sin que nadie toque una linea. Estando en el `.env`,
el riesgo solo cambia cuando una persona lo cambia.

### Por que `null` y no `NaN` en los indicadores

Un `NaN` se propaga en silencio por toda la cuenta y termina en una orden con
cantidad invalida. Un `null` rompe temprano y fuerte. Ver el caso del z-score de
volumen en `src/indicators/index.ts`: cuando no hay dispersion previa devuelve
`null` en vez de `0`, porque `0` le diria al modelo "volumen normal" justo
durante el primer pico, que es el caso que mas importa detectar.

### Por que el backtest reusa los modulos del vivo

`src/backtest/runner.ts` importa `buildDecisionState`, `decidePlan`,
`checkHardExits` y `computeBuyQuantity` — los mismos que usa `engine.ts`. Un
backtest que reimplementa la logica termina midiendo un bot que no existe.

### Por que el simulador cobra comisiones y slippage

Un simulador sin costos siempre parece rentable. `PaperBroker` cruza contra el
ask al comprar y contra el bid al vender, aplica slippage que siempre empeora el
precio y cobra `FEE_RATE`. Hay un test que verifica que una vuelta completa sin
movimiento de precio **pierde** exactamente spread mas comisiones.

### Por que el tamano sale de dividir riesgo por distancia al stop

```
cantidad = (equity × RISK_PER_TRADE_PCT) / distancia_al_stop
```

Con el stop al 5% y riesgo del 1%, la posicion es el 20% del equity. Si la
volatilidad sube y el stop se va al 10%, la posicion baja sola al 10%. La
perdida maxima por operacion queda constante sin tocar nada.

`RISK_PER_TRADE_PCT` **tiene que ser menor** que `HARD_STOP_PCT`; si fueran
iguales, este techo daria siempre el equity entero y no limitaria nada. La
validacion de `config.ts` lo impide al arrancar.

## Estado persistente

`data/state.json` guarda posicion abierta, pico de equity, contadores del dia,
corta-corriente, historial de operaciones y curva de equity. Se escribe a un
temporal y despues se renombra: si el proceso muere a mitad de la escritura, el
archivo viejo queda intacto en vez de truncado.

Un bot que arranca amnesico vuelve a operar contra sus propios limites, por eso
el estado se persiste despues de cada operacion.

## Cambiar de exchange

`engine.ts` no conoce Kraken: conoce la interfaz `Broker`
(`src/broker/types.ts`), con cuatro metodos. Portarlo a otro exchange es escribir
otra implementacion de esa interfaz, sin tocar la estrategia ni el riesgo.
