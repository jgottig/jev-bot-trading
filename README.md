# jev-bot-trading

Bot de trading de cripto que toma decisiones con **Jev**, el modelo System One de
[TypeSafe AI](https://typesafe.ai), y ejecuta las operaciones en **Kraken**.

Incluye simulador (paper trading), backtesting y una capa de riesgo que el modelo
no puede sobrepasar. Arranca sin credenciales y sin plata.

---

## El stack, y por que

| Pieza | Eleccion | Costo | Por que |
|---|---|---|---|
| **Decision** | Jev (`jev-latest`) vía `@typesafe-ai/sdk` | USD 0,042 / 1M tokens de entrada · salida gratis → **~USD 0,40 al mes** | Devuelve decisiones tipadas con probabilidades en 70–500 ms, no texto para parsear. Es la pieza que pediste. |
| **Ejecucion** | Kraken Spot (REST) | **0,40% por orden** (taker, tramo base) | Opera legalmente en Argentina: registrado como PSAV ante la CNV desde mayo 2026, con deposito directo en pesos. Claves API con permisos granulares. |
| **Datos de mercado** | Kraken API publica | **Gratis**, sin clave | Las velas que alimentan los indicadores salen de la misma fuente donde se ejecuta, asi que no hay desfasaje entre lo que el bot ve y donde opera. |
| **Activo** | BTC/USD (`XBTUSD`) | — | El de mayor liquidez y menor spread. Con capital chico, el spread y las comisiones se comen el resultado antes que cualquier error de estrategia. |
| **Runtime** | Node 20+ / TypeScript | Gratis | El SDK de Jev es TypeScript de primera clase. |

**El costo que importa es el del exchange, no el del modelo.** Una sola
operacion en Kraken (~USD 2,30 sobre una posicion de 250) cuesta casi seis meses
de consultas a Jev. Detalle completo en [`docs/COSTS.md`](docs/COSTS.md).

### Sobre Robinhood

Fue la idea original pero **no sirve para este caso**: su API de cripto es solo
para residentes de EE.UU. y **no tiene sandbox** — se opera unicamente con plata
real, sin forma de probar antes.

### Sobre la "billetera aislada"

Lo que buscas no es una wallet self-custody tipo MetaMask. Con una wallet el bot
tendria que operar en exchanges descentralizados, pagando gas en cada orden y
sufriendo slippage: inviable para operaciones chicas y frecuentes.

El aislamiento real se consigue asi:

1. **Cuenta nueva en Kraken**, separada de cualquier otra que tengas.
2. **Clave API sin permiso de retiro.** Kraken permite habilitar solo
   operar y consultar. Aunque la clave se filtre entera, nadie puede sacar
   fondos de la cuenta: solo comprar y vender adentro.
3. **Fondeo con un monto fijo chico.** Lo que pongas ahi es todo lo que existe.

Eso es una caja aislada de verdad, y no depende de que el codigo sea perfecto.

---

## Que ve Jev, y que no

Preguntaste si puede ver pantalla. **No.** Jev no ve pantallas, ni graficos, ni
navega internet. No tiene ojos ni manos.

Lo unico que recibe es un objeto JSON que arma
[`src/brain/features.ts`](src/brain/features.ts) en cada ciclo:

```jsonc
{
  "market": {
    "price":      { "last": 50123.4, "spread_bps": 3.2, "change_24_candles_pct": 1.8 },
    "trend":      { "ema_fast": 50210, "ema_slow": 49980, "ema_gap_pct": 0.46 },
    "momentum":   { "rsi_14": 58.3, "macd_histogram_pct": 0.042 },
    "volatility": { "atr_pct": 1.24, "realized_vol_annualized_pct": 47.2 },
    "volume":     { "z_score": 0.83 },
    "recent_candles": [ /* las ultimas 12 velas en crudo */ ]
  },
  "portfolio": { "has_open_position": false, "cash_usd": 1000, "equity_usd": 1000 },
  "session":   { "trades_today": 0, "drawdown_from_peak_pct": 0 }
}
```

Y **tampoco ejecuta ordenes**. Jev no tiene acceso al exchange. Solo responde
preguntas. Quien manda las ordenes es el codigo del bot.

### Cuanto tarda

| Etapa | Demora |
|---|---|
| Bajar velas + cotizacion de Kraken | ~100–400 ms |
| Calcular indicadores | <5 ms |
| **Consulta a Jev** | **~70–500 ms** |
| Politica + dimensionamiento | <1 ms |
| Mandar la orden a Kraken | ~100–300 ms |
| Confirmar la ejecucion | ~300 ms–2 s |
| **Total: estado enviado → orden ejecutada** | **~0,5–3 segundos** |

Pero la demora que de verdad importa **no es esa**: es `LOOP_INTERVAL_SEC`, que
por defecto son **300 segundos**. El bot mira el mercado cada 5 minutos, asi que
entre que el precio se mueve y el bot reacciona pueden pasar hasta 5 minutos.

Es deliberado. Esto **no es un bot de alta frecuencia** y no puede competir con
uno: opera sobre velas de 1 hora buscando movimientos de mas de 1,4%, donde
llegar tres segundos antes o despues no cambia nada. Bajar el intervalo no lo
hace mejor, lo hace mas caro — cada operacion de mas cuesta 0,80%.

La unica excepcion son los stops, que **tambien** se evaluan cada 5 minutos. Si
el precio se derrumba entre dos ciclos, se vende al precio que haya. El stop
limita la perdida esperada, no la garantiza.

### Como decide, exactamente

Jev no genera texto, asi que el bot no le pregunta "¿que hago?". Le hace cinco
preguntas concretas y recibe probabilidades:

| Pregunta | Tipo | Respuesta |
|---|---|---|
| `action` | choice | `buy` / `sell` / `hold` + probabilidad de cada una + confianza |
| `conviction` | score | 0 a 4 sobre una rubrica explicita |
| `regime` | choice | `trending_up` / `trending_down` / `ranging` / `high_volatility` |
| `downside_risk` | noul | probabilidad 0–1 de caida brusca |
| `exit_now` | noul | probabilidad 0–1 de que convenga cerrar ya |

Despues **el codigo decide**, con umbrales explicitos en el `.env`
([`src/brain/policy.ts`](src/brain/policy.ts)). Para abrir una posicion tienen
que abrirse *todas* estas compuertas:

```
action == "buy"              AND  p(buy)     >= MIN_BUY_PROBABILITY
confianza >= MIN_CONFIDENCE  AND  conviccion >= MIN_CONVICTION
downside_risk <= MAX_RISK_PROBABILITY
regime != "trending_down"    AND  spread <= MAX_SPREAD_BPS
objetivo >= costo_ida_y_vuelta x MIN_EDGE_MULTIPLE     <-- la compuerta de costo
```

Esa ultima es la que mas operaciones descarta. Con un costo de vuelta de ~0,92%
y `MIN_EDGE_MULTIPLE=1.5`, el objetivo tiene que ser de al menos **1,38%**. Si
el ATR del momento no da para tanto, el bot no entra por convencido que este
Jev: entrar seria pagarle la comision al exchange con plata tuya.

Esto es deliberado: si manana Jev cambia de version y se vuelve mas optimista, el
riesgo **no se mueve** salvo que alguien edite esos numeros a mano.

### Lo que el modelo nunca puede hacer

El orden de cada ciclo pone el riesgo primero:

```
1. Bajar velas + cotizacion
2. ¿Corta-corriente / drawdown maximo?      -> registrar
3. ¿Stop loss, trailing, objetivo, tiempo?  -> CERRAR, sin consultar al modelo
4. ¿Frenos activos?                         -> no abrir nada
5. ---- recien aca se consulta a Jev ----
6. Politica: ¿pasa todas las compuertas?
7. Riesgo: ¿que tamano corresponde?
8. Ejecutar
```

Los pasos 2, 3, 4 y 7 son codigo deterministico. Si Jev alucina un "comprar" en
medio de un derrumbe, ya lo freno el paso 4. Y si dice "mantener" mientras el
stop se perfora, el paso 3 ya cerro la posicion sin preguntarle.

**El bot es solo largo**: compra y vende al contado. Nunca vende en corto ni usa
apalancamiento, asi que no puede perder mas de lo que hay en la cuenta.

---

## Arranque rapido

```bash
git clone https://github.com/jgottig/jev-bot-trading.git
cd jev-bot-trading
npm install
cp .env.example .env
```

### 1. Backtest — sin cuentas, sin claves, sin plata

```bash
npm run backtest -- --days=90
```

Descarga 90 dias de velas reales de Kraken y corre la estrategia completa contra
ese historico. Compara el resultado con comprar y sostener.

### 2. Paper trading — precios reales, plata ficticia

Ponés tu clave de Jev en `.env` (`TYPESAFE_API_KEY=...`) y:

```bash
npm run doctor   # verifica conexiones
npm run once     # un solo ciclo, para ver que decide
npm run run      # bucle continuo
npm run status   # posicion, resultados, estado del corta-corriente
```

Sin `TYPESAFE_API_KEY` el bot igual funciona: usa un cerebro heuristico de
reserva, que ademas sirve como linea de base para medir si Jev aporta algo.

### 3. Real — recien despues de mirar los numeros

Ver [`docs/SETUP-KRAKEN.md`](docs/SETUP-KRAKEN.md) para crear la cuenta y la
clave API con los permisos correctos. Despues:

```bash
# Primero dryrun: Kraken valida las ordenes de verdad pero NO las ejecuta
MODE=dryrun npm run once

# Y solo cuando eso salga limpio
MODE=live npm run run
```

---

## Comandos

| Comando | Que hace |
|---|---|
| `npm run doctor` | Verifica configuracion, conexion a Kraken y a Jev |
| `npm run once` | Un solo ciclo de decision |
| `npm run run` | Bucle continuo |
| `npm run status` | Posicion abierta, resultados, corta-corriente |
| `npm run flat` | **Cierra la posicion a mercado, ahora** |
| `npm run backtest -- --days=90` | Backtest con el cerebro heuristico |
| `npm run backtest -- --days=30 --jev` | Backtest usando Jev (consume credito) |
| `npm test` | 147 tests |
| `npx tsx src/cli.ts reset-kill-switch` | Reactiva tras un apagado de emergencia |

Para frenar el bot sin matar el proceso: `ALLOW_ENTRIES=false`. Deja de abrir
posiciones nuevas pero sigue vigilando el stop de la que tenga abierta.

---

## Protecciones de riesgo

Todas configurables en `.env`, todas deterministicas:

| Proteccion | Por defecto | Que hace |
|---|---|---|
| `RISK_PER_TRADE_PCT` | 1% | Perdida maxima por operacion. Define el tamano. |
| `HARD_STOP_PCT` | 5% | Distancia maxima del stop |
| `STOP_ATR_MULT` | 2× ATR | Stop adaptado a la volatilidad del momento |
| `TRAILING_STOP_PCT` | 3% | Stop que sube con el precio y nunca baja |
| `DAILY_LOSS_LIMIT_PCT` | 3% | Frena las entradas por el resto del dia |
| `MAX_DRAWDOWN_PCT` | 15% | **Apaga el bot** hasta que lo reactives a mano |
| `MAX_TRADES_PER_DAY` | 6 | Tope de operaciones diarias |
| `COOLDOWN_MIN` | 30 min | Espera obligatoria despues de cerrar |
| `MAX_SPREAD_BPS` | 20 | No opera con el libro demasiado abierto |
| `MIN_EDGE_MULTIPLE` | 1.5× | El objetivo debe cubrir 1,5 veces el costo de operar |
| `FEE_RATE` | 0.40% | Arancel taker del tramo base de Kraken |

El tamano de la posicion sale de dividir el riesgo aceptado por la distancia al
stop. Cuando la volatilidad crece, el stop se aleja y **la posicion entra mas
chica sola**, sin que nadie toque un parametro.

---

## ¿Cuánto capital hace falta?

`npm run doctor` lo verifica y te avisa antes de que fondees. Hay dos formas
distintas de que el capital no alcance:

1. **Mecánica**: la posición queda por debajo del mínimo del exchange y el bot
   nunca abre una orden. Se ve enseguida.
2. **Económica**: el bot opera bien, pero la ganancia posible es tan chica en
   términos absolutos que no cubre el costo de la API que la genera. Esta es
   peor, porque el bot parece funcionar mientras destruye valor.

| Capital | Posición (25%) | ¿Opera? | Ganancia 15%/año | La API se lleva |
|---:|---:|:---:|---:|---:|
| USD 19 | 4,75 | **No** | 2,85 | **170%** |
| USD 40 | 10,00 | **No** | 6,00 | 81% |
| USD 100 | 25,00 | Sí | 15,00 | 32% |
| USD 250 | 62,50 | Sí | 37,50 | 13% |
| **USD 500** | 125,00 | Sí | 75,00 | **6%** |
| USD 1.000 | 250,00 | Sí | 150,00 | 3% |

**Mínimo razonable: USD 500.** Por debajo de USD 100 el bot directamente no
abre operaciones con la configuración por defecto.

El paper trading, en cambio, es gratis e ilimitado: podés simular USD 1.000 sin
tener USD 1.000.

## Antes de poner plata, leé esto

- **Esto puede perder dinero.** Es software de trading automatico sobre un activo
  volatil. No hay garantia de rentabilidad, y un backtest bueno no predice nada.
- **Un backtest mide un pasado que ya no se repite.** Ademas el de aca no simula
  huecos de precio ni la ampliacion del spread, que siempre ocurre en el peor
  momento. Trata sus resultados como el techo optimista, no como lo esperable.
- **Poné solo lo que puedas perder entero.**
- **Las comisiones importan mas de lo que parece.** Cada vuelta completa cuesta
  **0,80% en comisiones** mas el spread. Un bot que opera mucho pierde por ahi
  aunque acierte la direccion. Por eso existe la compuerta `cost_edge` y por eso
  los frenos por defecto son restrictivos.
- **La clave API no debe tener permiso de retiro.** Nunca.
- **`data/` y `.env` no van al repositorio.** Ya estan en `.gitignore`.

Detalle completo en [`docs/RISK.md`](docs/RISK.md).

---

## Estructura

```
src/
├── brain/
│   ├── features.ts    Arma el JSON que ve Jev (lo unico que ve)
│   ├── jev.ts         Las 5 preguntas tipadas y la llamada al modelo
│   ├── heuristic.ts   Cerebro de reglas: linea de base y backtesting
│   └── policy.ts      Umbrales: traduce probabilidades en intencion de operar
├── risk/
│   ├── manager.ts     Stops, frenos, tamano. El modelo no lo puede sobrepasar.
│   ├── costs.ts       Comisiones, punto de equilibrio y rentabilidad esperada
│   └── viability.ts   ¿Alcanza el capital para que esto tenga sentido?
├── broker/
│   ├── paper.ts       Simulador con comisiones y slippage reales
│   └── kraken.ts      Cliente REST firmado (HMAC-SHA512 + nonce creciente)
├── marketdata/        Velas y cotizaciones de la API publica de Kraken
├── indicators/        EMA, RSI, ATR, MACD, Bollinger, volatilidad realizada
├── state/store.ts     Persistencia: posicion, resultados, corta-corriente
├── engine.ts          El ciclo completo
└── backtest/runner.ts Backtest reusando los mismos modulos que el vivo
```

Mas detalle en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) y
[`docs/COSTS.md`](docs/COSTS.md).

---

## Licencia

MIT. Uso bajo tu propia responsabilidad.
