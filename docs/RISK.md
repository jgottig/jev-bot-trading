# Riesgos

Documento honesto sobre lo que puede salir mal. Leelo entero antes de poner plata.

## Lo primero

**Este bot puede perder dinero, y perderlo todo.** Opera automaticamente sobre un
activo volatil. No hay garantia de rentabilidad de ningun tipo.

Pone solo lo que puedas perder entero sin que te cambie nada.

## Riesgos de mercado

### El bot es solo largo
Compra y vende al contado. No vende en corto ni usa apalancamiento. Eso acota la
perdida maxima al capital de la cuenta — no podes quedar debiendo. Pero tambien
significa que **en un mercado bajista sostenido el bot no puede ganar**: lo mejor
que puede hacer es quedarse afuera.

### Huecos de precio
Los stops se evaluan cada ciclo (5 minutos por defecto). Si el precio se
derrumba entre dos ciclos, la venta se ejecuta al precio que haya, que puede
estar muy por debajo del stop. **El stop limita la perdida esperada, no la
garantiza.**

### Comisiones y spread
Cada vuelta completa cuesta ~0.52% en fees mas el spread. El precio tiene que
moverse mas de medio punto a tu favor solo para empatar. Un bot que opera de mas
pierde por ahi aunque acierte la direccion — por eso el tope diario por defecto
es 6 operaciones.

## Limites del backtest

El backtest de este repo:

- Evalua cada vela **en su cierre**. No ve lo que pasa adentro de la vela, asi
  que un stop y un objetivo tocados en la misma vela se resuelven en el orden que
  define el codigo, no en el que realmente ocurrio.
- **No simula huecos de precio.** Asume que el stop se ejecuta a su precio.
- **Asume el spread constante.** En la realidad se abre justo cuando peor viene.
- No modela profundidad del libro: supone que tu orden no mueve el precio. Cierto
  para montos chicos en BTC, falso en pares ilíquidos.

Tratá sus resultados como **el techo optimista**, no como lo esperable. Un
backtest bueno es condicion necesaria, nunca suficiente.

Y sobre todo: un backtest mide un pasado que ya no se repite. Una estrategia
ajustada hasta lucir bien sobre datos historicos suele fallar en vivo — cuantos
mas parametros toques mirando el resultado, mas estaras ajustando al ruido.

## Riesgos tecnicos

### Caida del proceso
Si el proceso muere con una posicion abierta, **el stop deja de vigilarse**. El
estado queda en disco y al reiniciar el bot retoma la posicion, pero entre medio
no hay nadie mirando. Para correrlo en serio, usa un supervisor (`systemd`,
`pm2`) que lo reinicie solo.

### Caida de la API
Si Kraken o TypeSafe no responden, el ciclo falla y se registra el error. El bot
no se cae: reintenta al ciclo siguiente. Pero durante ese rato no vigila nada.

### Fallo del modelo
Si Jev devuelve algo inesperado o no responde, ese ciclo no abre posiciones. Las
salidas duras siguen funcionando porque son codigo deterministico y se evaluan
antes de consultarlo.

### Filtracion de credenciales
Por eso la clave API **no debe tener permiso de retiro**. Con ese permiso apagado,
una clave filtrada permite comprar y vender dentro de tu cuenta, pero no sacar
fondos. Es la unica proteccion que no depende de que el codigo sea correcto.

`.env` y `data/` estan en `.gitignore`. No los subas, no los pegues en un chat,
no los muestres en una captura.

## Riesgos de operacion

### Los parametros por defecto no son un consejo
Los valores del `.env.example` son un punto de partida conservador, no una
recomendacion calibrada para vos. Nadie ajusto esos numeros a tu tolerancia al
riesgo ni a tu capital.

### El corta-corriente exige intervencion humana
Cuando el drawdown supera `MAX_DRAWDOWN_PCT` el bot se apaga y **no vuelve solo**.
Hay que reactivarlo a mano con `reset-kill-switch`. Es a proposito: si se
reactivara solo, seguiria perdiendo contra la misma condicion que lo apago.

Antes de reactivarlo, entende que paso. Mira `npm run status` y el historial de
operaciones.

## Impuestos

En Argentina las operaciones con cripto pueden generar obligaciones fiscales.
Este software no lleva registro contable ni emite ningun comprobante. Los datos
de `data/state.json` son un registro tecnico, no documentacion fiscal.
Consulta a un contador.

## Antes de pasar a real, checklist

- [ ] Corri el backtest y entendi los resultados, incluida la comparacion contra
      comprar y sostener
- [ ] Corri paper trading varios dias y mire las decisiones en el log
- [ ] `MODE=dryrun npm run once` sale limpio
- [ ] La clave API **no** tiene permiso de retiro
- [ ] La cuenta esta separada de cualquier otra cuenta personal
- [ ] El monto fondeado es plata que puedo perder entera
- [ ] Entendi que `npm run flat` cierra todo al instante
- [ ] Se donde estan los logs y como leerlos
