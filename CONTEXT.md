# CONTEXT.md — estado del proyecto y decisiones tomadas

Documento de traspaso. Resume qué es este bot, por qué está construido así, y
qué hace falta para ponerlo a correr.

> **Nota para quien venga de otra sesión:** si te dijeron que esto integra
> **Robinhood, esa información es vieja**. Robinhood fue evaluado y descartado
> con fundamento; no hay ni una línea de código de Robinhood en el repo. El
> exchange es **Kraken**. Ver la sección "Por qué NO Robinhood".

---

## 1. Qué es

Bot de trading de cripto que toma decisiones con **Jev** (modelo System One de
TypeSafe AI) y ejecuta en **Kraken**. Long-only spot, sin apalancamiento.

- **Lenguaje:** TypeScript, Node 20+, ESM
- **Tests:** 147, sin dependencia de red (fetch mockeado + fixtures)
- **Estado:** funcional y verificado offline. **Nunca se ejecutó contra las APIs
  reales** — ver "TODOs pendientes".

---

## 2. Qué es Jev y cómo decide

Jev **no es un LLM y no genera texto.** Es un "System One model": evalúa un
estado y devuelve respuestas tipadas con probabilidades calibradas. Latencia de
70–500 ms, USD 0,042 por millón de tokens de entrada (salida gratis).

- SDK: `@typesafe-ai/sdk` v0.6.0
- Endpoint: `POST https://api.typesafe.ai/v1/systemone`
- Modelo: `jev-latest`
- Auth: `Authorization: Bearer <TYPESAFE_API_KEY>` (lo maneja el SDK)

### Lo que Jev ve

**Solo un objeto JSON.** No ve pantallas, ni gráficos, ni navega internet. El
estado lo arma `src/brain/features.ts`: indicadores ya calculados (EMA, RSI,
ATR, MACD, Bollinger, z-score de volumen), la cartera, la sesión y los costos.

### Las cinco preguntas (`src/brain/jev.ts`)

Una sola llamada por ciclo, con cinco preguntas tipadas:

| Nombre | Tipo | Devuelve |
|---|---|---|
| `action` | `choice` | `buy`/`sell`/`hold` + probabilidad de cada una + confianza |
| `conviction` | `score` | 0–4 sobre rúbrica explícita (puede ser fraccionario) |
| `regime` | `choice` | `trending_up`/`trending_down`/`ranging`/`high_volatility` |
| `downside_risk` | `noul` | probabilidad 0–1 de caída brusca |
| `exit_now` | `noul` | probabilidad 0–1 de cerrar ya |

Las preguntas están **en inglés a propósito**: TypeSafe documenta que el modelo
está calibrado principalmente en inglés. El resto del proyecto está en
castellano. No las traduzcas sin medir el impacto.

### Jev NO decide, y NO ejecuta

Este es el punto de diseño central. Jev devuelve probabilidades; **quien decide
es `src/brain/policy.ts`**, con umbrales explícitos que viven en el `.env`.
Jev tampoco tiene acceso al exchange: las órdenes las manda el código.

Orden de cada ciclo (`src/engine.ts`):

```
1. Bajar velas + cotización
2. ¿Corta-corriente / drawdown máximo?      → registrar
3. ¿Stop, trailing, objetivo, tiempo?       → CERRAR sin consultar al modelo
4. ¿Frenos activos?                         → no abrir nada
5. ---- recién acá se consulta a Jev ----
6. Política: ¿pasa todas las compuertas?
7. Riesgo: ¿qué tamaño corresponde?
8. Ejecutar y persistir
```

Los pasos 2, 3, 4 y 7 son deterministas. **Jev solo puede hacer que el bot opere
menos, nunca saltarse una protección.** Si no respetás esta invariante al
modificar el código, rompés la propiedad de seguridad principal del sistema.

---

## 3. Por qué NO Robinhood

Fue la idea original del usuario y se descartó por dos motivos verificados:

1. **La API de cripto de Robinhood es solo para residentes de EE.UU.** El
   usuario está en Argentina: no podría ni abrir la cuenta.
2. **No tiene sandbox.** No hay paper trading ni entorno de prueba: se opera
   únicamente con plata real. Imposible validar antes de arriesgar.

(Para referencia: su API usa firma Ed25519 sobre
`api_key + timestamp + path + method + body`, con cabeceras `x-api-key`,
`x-timestamp`, `x-signature`. **Nada de esto está implementado en el repo.**)

El nombre de la rama, `claude/jev-trading-bot-robinhood-90bphg`, quedó del
pedido original y es lo único que menciona Robinhood.

### Por qué Kraken

- Opera legalmente en Argentina: registrado como PSAV ante la CNV desde mayo
  2026, con depósito directo en pesos.
- Claves API con permisos granulares: se puede habilitar operar **sin** permiso
  de retiro. Ese es el aislamiento real de la cuenta.
- `AddOrder` acepta `validate=true`: valida la orden de verdad sin ejecutarla.
- Datos de mercado públicos y gratuitos, sin credenciales.

**Auth de Kraken** (`src/broker/kraken.ts`):

```
API-Sign = base64( HMAC-SHA512( uriPath || SHA256(nonce || postdata),
                               base64decode(API_SECRET) ) )
```

Cabeceras `API-Key` y `API-Sign`. El nonce debe crecer estrictamente (usamos
microsegundos con incremento forzado). **La implementación está verificada
contra el vector de prueba oficial de Kraken** — ver `test/kraken.test.ts`. Si
ese test se rompe, ninguna llamada privada autentica.

---

## 4. Activo y estrategia

- **Par:** `XBTUSD` (Kraken llama XBT a Bitcoin). Mayor liquidez, menor spread.
- **Velas:** 60 minutos. **No lo bajes sin leer la sección de costos**: con 15m
  el movimiento típico no cubre las comisiones y el bot no entraría nunca.
- **Dirección:** solo largo. Compra y vende al contado. Nunca vende en corto ni
  usa margen, así que no se puede perder más que el capital de la cuenta.

### Parámetros de riesgo (todos en `.env`)

| Parámetro | Default | Qué hace |
|---|---|---|
| `MAX_POSITION_PCT` | 25% | Techo de exposición por posición |
| `RISK_PER_TRADE_PCT` | 1% | Pérdida máxima por operación → define el tamaño |
| `HARD_STOP_PCT` | 5% | Distancia máxima del stop |
| `STOP_ATR_MULT` / `TAKE_PROFIT_ATR_MULT` | 2× / 3× ATR | Stop y objetivo adaptados a volatilidad |
| `TRAILING_STOP_PCT` | 3% | Sube con el precio, nunca baja |
| `DAILY_LOSS_LIMIT_PCT` | 3% | Frena entradas por el resto del día |
| `MAX_DRAWDOWN_PCT` | 15% | **Apaga el bot** hasta reactivación manual |
| `MIN_EDGE_MULTIPLE` | 1.5× | El objetivo debe cubrir 1,5× el costo de operar |

El tamaño sale de `(equity × RISK_PER_TRADE_PCT) / distancia_al_stop`. Cuando
sube la volatilidad, el stop se aleja y **la posición se achica sola**.

> `RISK_PER_TRADE_PCT` **tiene que ser menor** que `HARD_STOP_PCT`. Si fueran
> iguales, ese techo daría siempre el equity entero y no limitaría nada — era un
> bug real, corregido, y `config.ts` ahora lo valida al arrancar.

### Los costos deciden

Kraken cobra **0,40% taker** en el tramo base. Una vuelta completa cuesta
**~0,92%** con spread y slippage. Jev cuesta ~USD 0,40 **al mes**.

**Una sola operación cuesta casi seis meses de consultas al modelo.** Por eso
existe la compuerta `cost_edge`, que bloquea entradas cuyo objetivo no cubra
`MIN_EDGE_MULTIPLE` veces el costo. Nunca bloquea salidas: bloquear un stop para
ahorrar comisión convierte una pérdida chica en una grande.

Detalle en `docs/COSTS.md`.

---

## 5. Paper vs live

`MODE` tiene tres valores:

| Modo | Qué hace | Credenciales |
|---|---|---|
| `paper` (default) | Simulador local con precios reales, comisiones y slippage. No toca el exchange. | Solo Jev |
| `dryrun` | Manda la orden a Kraken con `validate=true`: valida saldo, mínimos y decimales **sin ejecutar**. | Jev + Kraken |
| `live` | Órdenes reales con plata real. | Jev + Kraken |

El `PaperBroker` cruza contra el ask al comprar y el bid al vender, aplica
slippage que siempre empeora el precio y cobra `FEE_RATE`. Hay un test que
verifica que una vuelta sin movimiento de precio **pierde** exactamente spread
más comisiones: un simulador sin costos siempre parece rentable.

---

## 6. Variables de entorno

**Nombres solamente. Nunca commitear valores.** `.env` y `.env.demo` con
valores reales están en `.gitignore`; usar `.env.example` como plantilla.

**Credenciales:**
- `TYPESAFE_API_KEY` — sin ella el bot corre igual, con el cerebro heurístico
- `TYPESAFE_MODEL` — default `jev-latest`
- `KRAKEN_API_KEY` — solo para `dryrun`/`live`
- `KRAKEN_API_SECRET` — ídem

**Operación:** `MODE`, `PAIR`, `CANDLE_INTERVAL_MIN`, `LOOP_INTERVAL_SEC`,
`DATA_DIR`, `LOG_LEVEL`, `ALLOW_ENTRIES`

**Capital:** `PAPER_STARTING_CASH`, `MAX_POSITION_PCT`, `MIN_ORDER_USD`

**Riesgo:** `RISK_PER_TRADE_PCT`, `HARD_STOP_PCT`, `STOP_ATR_MULT`,
`TAKE_PROFIT_ATR_MULT`, `TRAILING_STOP_PCT`, `DAILY_LOSS_LIMIT_PCT`,
`MAX_DRAWDOWN_PCT`, `MAX_TRADES_PER_DAY`, `COOLDOWN_MIN`, `MAX_HOLDING_HOURS`,
`MAX_SPREAD_BPS`, `MIN_EDGE_MULTIPLE`

**Umbrales sobre Jev:** `MIN_BUY_PROBABILITY`, `MIN_CONFIDENCE`,
`MIN_CONVICTION`, `MAX_RISK_PROBABILITY`, `EXIT_PROBABILITY`

**Costos:** `FEE_RATE`, `PAPER_SLIPPAGE_BPS`

### Permisos de la clave de Kraken

Habilitar: `Query Funds`, `Query Open/Closed Orders`, `Create & Modify Orders`,
`Cancel/Close Orders`.

**Dejar APAGADO: `Withdraw Funds`.** Es la única protección que no depende de
que el código sea correcto: aunque la clave se filtre entera, nadie puede sacar
fondos de la cuenta.

---

## 7. Cómo correrlo

```bash
npm install
cp .env.example .env
```

**Sin ninguna cuenta ni clave** (datos públicos de Kraken):

```bash
npm run backtest -- --days=90    # backtest con cerebro heurístico
npm test                          # 147 tests
```

**Demo de un día** (paper, saldo virtual, sin cuenta de exchange):

```bash
npm run demo:doctor    # verifica conexiones y viabilidad del capital
npm run demo           # bucle continuo
npm run demo:status    # desde otra terminal
```

**Otros comandos:** `npm run once`, `npm run run`, `npm run status`,
`npm run flat` (cierra la posición a mercado ya),
`npx tsx src/cli.ts reset-kill-switch`.

Guía completa en `docs/DEMO.md`.

---

## 8. TODOs pendientes

### Bloqueantes antes de plata real

1. **Nunca se ejecutó contra las APIs reales.** Todo está testeado con `fetch`
   mockeado porque el contenedor donde se desarrolló tiene el egress bloqueado
   (`api.kraken.com` y `api.typesafe.ai` devuelven 403). **La primera conexión
   real es trabajo pendiente y hay que hacerla con `npm run demo:doctor`.**
2. **`MODE=dryrun` sin verificar** contra Kraken real. Es el paso obligatorio
   antes de `live`.
3. **Sin validación de la estrategia.** No sabemos si gana plata. Hace falta
   backtest largo + semanas de paper. Comparar siempre contra comprar y
   sostener y contra el cerebro heurístico (`src/brain/heuristic.ts`), que
   existe justamente como línea de base: si Jev no le gana, no está aportando.

### Mejoras identificadas, no implementadas

4. **Órdenes limit en vez de market**: 0,25% en lugar de 0,40%, casi 40% menos
   de comisión. A cambio, la orden puede no ejecutarse. Es la mejora de mayor
   impacto económico.
5. **Supervisor de proceso** (`systemd`/`pm2`): si el proceso muere con una
   posición abierta, su stop deja de vigilarse.
6. **Sin registro contable/fiscal.** `data/state.json` es un registro técnico,
   no documentación para ARCA.

### Limitaciones conocidas del backtest

Evalúa cada vela en su cierre, no simula huecos de precio, asume spread
constante y no modela profundidad del libro. **Sus resultados son el techo
optimista, no lo esperable.** Ver `docs/RISK.md`.

### Advertencia de capital

Con la configuración por defecto, **el mínimo razonable es USD 500**. Por debajo
de USD 100 el bot no abre operaciones (la posición queda bajo el mínimo del
par), y por debajo de ~USD 32 la API de Jev cuesta más que la ganancia anual
posible. `npm run demo:doctor` lo verifica y avisa antes de fondear.

---

## 9. Mapa del repo

```
src/
├── brain/
│   ├── features.ts    Arma el JSON que ve Jev (lo único que ve)
│   ├── jev.ts         Las 5 preguntas tipadas y la llamada al modelo
│   ├── heuristic.ts   Cerebro de reglas: línea de base y backtesting
│   └── policy.ts      Umbrales: probabilidades → intención de operar
├── risk/
│   ├── manager.ts     Stops, frenos, tamaño. El modelo no lo sobrepasa.
│   ├── costs.ts       Comisiones, punto de equilibrio, rentabilidad esperada
│   └── viability.ts   ¿Alcanza el capital para que esto tenga sentido?
├── broker/
│   ├── paper.ts       Simulador con comisiones y slippage reales
│   └── kraken.ts      Cliente REST firmado (HMAC-SHA512 + nonce creciente)
├── marketdata/        Velas y cotizaciones de la API pública de Kraken
├── indicators/        EMA, RSI, ATR, MACD, Bollinger, volatilidad realizada
├── state/store.ts     Persistencia con escritura atómica
├── engine.ts          El ciclo completo
└── backtest/runner.ts Backtest reusando los mismos módulos que el vivo

docs/  ARCHITECTURE.md · COSTS.md · DEMO.md · RISK.md · SETUP-KRAKEN.md
```

**El backtest importa los mismos módulos que el motor en vivo** (`features`,
`policy`, `checkHardExits`, `computeBuyQuantity`). No lo reimplementes por
separado: un backtest que duplica la lógica termina midiendo un bot que no
existe.
