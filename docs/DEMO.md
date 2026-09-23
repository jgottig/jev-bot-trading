# Dejar la demo corriendo un día

Paper trading: precios reales de mercado, plata ficticia, cero riesgo. No hace
falta cuenta de Kraken ni fondear nada.

## Qué prueba esto, y qué no

**Sí prueba** — la maquinaria:
- que el bot corre horas sin caerse
- que Jev responde y qué decide en cada ciclo
- que los indicadores se calculan sobre datos reales
- que las órdenes se ejecutan y el estado sobrevive un reinicio
- que los stops saltan cuando tienen que saltar

**No prueba** — la estrategia:

Un día son **~24 velas de 1 hora**. Eso no alcanza ni para una muestra. Podés
terminar con 2 operaciones o con ninguna, y en ambos casos no vas a saber nada
sobre si la estrategia gana plata.

Para eso está el backtest, que en dos minutos te da 180 días:

```bash
npm run backtest -- --days=180
```

**Corré los dos.** Son preguntas distintas.

---

## Arranque

```bash
git clone https://github.com/jgottig/jev-bot-trading.git
cd jev-bot-trading
npm install
```

### Opción A — sin ninguna cuenta

Funciona ya mismo, con el cerebro heurístico de reserva:

```bash
npm run demo
```

### Opción B — con Jev (lo que querés probar de verdad)

1. Sacá tu clave en [typesafe.ai](https://typesafe.ai)
2. Pegala en `.env.demo`:

```bash
TYPESAFE_API_KEY=tu_clave_aca
```

3. Verificá y arrancá:

```bash
npm run demo:doctor    # chequea Kraken + Jev
npm run demo           # arranca el bucle
```

Costo: **~USD 0,02 por día** de consultas a Jev. No necesitás claves de Kraken:
en paper el bot no toca el exchange, y los precios salen de la API pública.

---

## Dejarlo corriendo todo el día

Guardá el log, que después lo vas a querer:

```bash
npm run demo 2>&1 | tee demo-$(date +%F).log
```

Si cerrás la terminal el proceso muere. Para que sobreviva:

```bash
# Linux / macOS
nohup npm run demo > demo.log 2>&1 &

# o con tmux, que además te deja volver a mirar
tmux new -s bot 'npm run demo 2>&1 | tee demo.log'
#   salir sin cortar:  Ctrl+B, después D
#   volver:            tmux attach -t bot
```

En Windows, dejá la terminal abierta y la pantalla sin suspender.

### Mirarlo mientras corre

Desde otra terminal:

```bash
npm run demo:status
```

El log sale en JSON por línea. Para leerlo cómodo:

```bash
tail -f demo.log | jq -r '"\(.t[11:19])  \(.msg)  \(.action // .detail // "")"'
```

### Pararlo

`Ctrl+C`. Apaga limpio y deja el estado guardado. **La posición abierta queda
abierta** — para cerrarla:

```bash
npm run -- flat
```

---

## Qué vas a ver

### Un ciclo que no opera (lo más común)

```json
{"level":"info","msg":"veredicto","action":"hold","p":{"buy":0.31,"sell":0.12,"hold":0.57},
 "conviction":1.4,"regime":"ranging","downsideRisk":0.28,"latencyMs":180}
{"level":"info","msg":"ciclo","n":47,"action":"idle","detail":"No se abre: conviction"}
```

Eso está bien. **El bot mirando y no operando es el comportamiento correcto la
mayor parte del tiempo.** Si operara en cada ciclo, se fundiría en comisiones.

El campo `detail` te dice exactamente qué compuerta lo frenó.

### Una entrada

```json
{"level":"info","msg":"posicion abierta","quantity":0.00487,"price":51230.4,
 "stop":49705.2,"target":53520.1,"notional":249.49}
```

### Una salida

```json
{"level":"info","msg":"posicion cerrada","reason":"trailing_stop",
 "pnlUsd":8.42,"pnlPct":1.83,"entryPrice":51230.4,"exitPrice":52167.9}
```

`pnlUsd` ya viene **neto de las dos comisiones**.

---

## Al final del día

```bash
npm run demo:status
```

Te muestra operaciones cerradas, resultado acumulado, drawdown, y el desglose de
costos: comisiones del exchange contra costo del modelo.

### Cómo leer el resultado

| Lo que ves | Qué significa |
|---|---|
| **0 operaciones** | Lo más probable. No es un error: no hubo señal que superara los umbrales y el costo. Mirá los `detail` para ver qué compuerta frenó más. |
| **1–3 operaciones** | Lo esperable en un día movido. Muestra insuficiente para concluir nada. |
| **Resultado positivo** | No festejes. Con 2 operaciones es ruido. |
| **Resultado negativo** | Tampoco es señal de nada, por lo mismo. |
| **Muchas operaciones perdiendo** | Esto sí es información: los umbrales están demasiado flojos. |

Lo que de verdad importa de este día: **¿corrió sin caerse y las decisiones
tienen sentido cuando las leés?** Si sí, el sistema funciona y la pregunta
siguiente es la estrategia, que se responde con el backtest y con semanas de
paper, no con un día.

---

## Este perfil no es el de plata real

`.env.demo` tiene los umbrales de señal **más flojos** que `.env.example`, para
que veas actividad en un solo día:

| | Demo | Real |
|---|---|---|
| `MIN_BUY_PROBABILITY` | 0,45 | 0,60 |
| `MIN_CONFIDENCE` | 0,40 | 0,55 |
| `MIN_CONVICTION` | 1 | 2 |
| `MAX_TRADES_PER_DAY` | 50 | 6 |
| `MIN_EDGE_MULTIPLE` | 1,2 | 1,5 |

**Las operaciones van a ser de peor calidad. Es a propósito.**

Lo que **no** se aflojó es la matemática de costos: `FEE_RATE=0.004` son las
comisiones reales de Kraken. Si las bajáramos para que el resultado luciera
mejor, la demo sería una fantasía y no serviría para decidir nada.

Y `MIN_EDGE_MULTIPLE` sigue por encima de 1: aun en demo, el bot no entra en
operaciones que pierden plata por definición.
