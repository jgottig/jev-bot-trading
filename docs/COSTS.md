# Costos: que es gratis, que se paga, y cuanto

## Resumen

| Servicio | Precio | Necesita cuenta | Necesita clave |
|---|---|---|---|
| **Kraken API publica** (velas, cotizaciones) | **Gratis** | No | No |
| **Kraken Spot** (ejecutar ordenes) | **0.40% por orden** | Si | Si |
| **Jev / TypeSafe AI** | **USD 0.042 por millon de tokens de entrada**; salida gratis | Si | Si |
| Todo el codigo de este repo | Gratis (MIT) | — | — |

Las velas y cotizaciones salen de los endpoints publicos de Kraken, que no piden
credenciales. Por eso `npm run backtest` funciona recien clonado el repo, sin
cuentas y sin claves.

---

## 1. Kraken: la comision que decide todo

Arancel del tramo base (menos de USD 10.000 de volumen en 30 dias):

| | Maker | Taker |
|---|---|---|
| Kraken Pro spot | 0.25% | **0.40%** |

El bot usa **ordenes a mercado**, que siempre son taker. O sea **0.40% por
orden**, y una vuelta completa (comprar + vender) cuesta:

```
0.40%  comprar
0.40%  vender
0.02%  spread de BTC/USD (~2 bps en condiciones normales)
0.10%  slippage asumido (5 bps por punta)
------
0.92%  ← lo que el precio tiene que subir SOLO PARA EMPATAR
```

### Sobre un capital de USD 1.000

Con `MAX_POSITION_PCT=0.25`, una posicion tipica es de USD 250:

| Concepto | Monto |
|---|---|
| Comision al comprar | USD 1.00 |
| Comision al vender | USD 1.00 |
| Spread + slippage | ~USD 0.30 |
| **Costo total de la operacion** | **~USD 2.30** |

Al tope de 6 operaciones diarias eso da **USD 13,80 por dia**, o **USD 414 al
mes: el 41% del capital**. Por eso los frenos por defecto son restrictivos, y
por eso existe la compuerta de rentabilidad.

### Como bajarlo

- **Operar menos.** Es la palanca mas grande y la mas facil.
- **Velas mas largas.** El default es 60m justamente por esto: un movimiento de
  vela horaria cubre el costo, uno de 15m rara vez.
- **Ordenes limite** en vez de a mercado: 0.25% en lugar de 0.40%, casi 40%
  menos. A cambio, la orden puede no ejecutarse. No esta implementado; seria el
  proximo paso natural si el bot demuestra funcionar.
- **Volumen.** Pasando los USD 10.000 mensuales el taker baja a 0.35%. Poco
  relevante con capital chico.

---

## 2. Jev: despreciable, pero lo contabilizamos

**USD 0.042 por millon de tokens de entrada. Los de salida no se cobran** —
tiene sentido, porque Jev devuelve valores estructurados cortos, no parrafos.

Medido sobre el payload real de este bot:

| | Caracteres | Tokens aprox. |
|---|---|---|
| Estado del mercado (`state`) | 1.757 | ~440–500 |
| Las cinco preguntas | 2.342 | ~590–670 |
| **Total por ciclo** | **4.099** | **~1.030–1.170** |

| Periodo | Ciclos | Costo |
|---|---|---|
| Un ciclo | 1 | **USD 0,000046** |
| Un dia (cada 5 min) | 288 | USD 0,013 |
| **Un mes** | 8.640 | **USD 0,40** |
| Un ano | 105.120 | USD 4,85 |

### La comparacion que importa

**Una sola operacion en Kraken (USD 2,30) cuesta casi seis meses de consultas
a Jev (USD 0,40 al mes).**

La comision del exchange es del orden de **50.000 veces** el costo de la
decision. Cualquier optimizacion de tokens es irrelevante; cualquier operacion
de mas es cara. Por eso la logica de costos del bot vigila las comisiones y solo
lleva la cuenta de los tokens.

> Dato util: las preguntas ocupan mas que el estado (2.342 contra 1.757
> caracteres) y viajan identicas en cada llamada. Si algun dia el costo del
> modelo importara, ahi esta el recorte — pero hoy no importa.

---

## 3. Como entra el costo en la decision

### Al entrar: compuerta dura

Antes de abrir, `src/risk/costs.ts` compara el objetivo de la operacion contra
su costo de ida y vuelta:

```
objetivo_bps  >=  costo_bps  x  MIN_EDGE_MULTIPLE
```

Con el default de `1.5` y un costo de 92 bps, el objetivo tiene que ser de al
menos **138 bps (1,38%)**. Si el ATR del momento no da para eso, el bot **no
entra**, por convencido que este Jev. Aparece en el log como la compuerta
`cost_edge`.

No alcanza con que el objetivo supere el costo: hace falta margen, porque **el
objetivo se alcanza solo una parte de las veces mientras que el costo se paga
siempre**, incluidas las operaciones que terminan en el stop.

### Al salir: informacion, nunca bloqueo

El costo **nunca** bloquea una salida. Bloquear un stop loss para ahorrar
comision es la forma mas rapida de convertir una perdida chica en una grande.

Lo que si hacemos es darle contexto a Jev en el estado:

```jsonc
"portfolio": {
  "entry_price": 50000,
  "breakeven_price": 50401.6,          // el precio que hace falta solo para empatar
  "unrealized_pnl_pct": 0.60,          // lo que dice el precio
  "net_pnl_if_closed_now_pct": -0.20   // lo que queda si cerramos ahora
}
```

Ese contraste es exactamente lo que un operador humano mira antes de cerrar: la
posicion parece ganar 0,60% pero **cerrarla deja una perdida de 0,20%**. Sin ese
dato el modelo no puede distinguir una ganancia real de una que se entrega
entera en comisiones.

### En el estado de mercado

```jsonc
"costs": {
  "round_trip_cost_pct": 0.92,   // lo que cuesta la vuelta completa
  "atr_to_cost_ratio": 1.43      // cuantas veces el movimiento tipico cubre ese costo
}
```

Cuando `atr_to_cost_ratio` baja de 1, el mercado se mueve menos de lo que cuesta
operarlo: no hay estrategia que gane ahi.

---

## 4. Lo que vas a ver

`npm run status`:

```
  COSTOS
    Comisiones del exchange: 9.20 USD  (4 ordenes)
    Consultas a Jev:         0.004182 USD  (91 llamadas)
    Las comisiones son 2200x el costo del modelo.
```

`npm run backtest`:

```
    Comisiones:        41.30 USD  (4.13% del capital inicial)
    Resultado bruto:   12.80 USD  (antes de comisiones)
    Costo por vuelta:  0.80% + spread

    ATENCION: la estrategia acerto la direccion (bruto positivo) pero las
    comisiones se comieron la ganancia entera.
```

Ese aviso es el que mas te va a servir: distingue una estrategia que no funciona
de una que funciona pero opera demasiado. Son problemas distintos con soluciones
distintas.
