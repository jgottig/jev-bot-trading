# Crear la cuenta y la clave API en Kraken

Kraken opera en Argentina desde mayo de 2026, registrado como Proveedor de
Servicios de Activos Virtuales (PSAV) ante la CNV, con deposito directo en pesos.

> El registro PSAV habilita a la empresa a operar en el pais. **No** implica que
> la CNV supervise tus operaciones ni que tus fondos esten garantizados.

---

## 1. La cuenta

1. Entra a [kraken.com](https://www.kraken.com) y crea una cuenta **nueva**,
   separada de cualquier otra que uses personalmente. El aislamiento empieza aca.
2. Completa la verificacion de identidad (KYC). Es obligatoria y puede tardar
   desde minutos hasta un par de dias.
3. Activa la autenticacion en dos pasos. Usa una app tipo Authy o Google
   Authenticator, **no SMS**.

## 2. Fondear

Podes depositar pesos por transferencia desde tu banco, o enviar USDT/USDC desde
otro exchange.

**Empeza con poco.** Un monto que te resulte indiferente perder entero. El bot
opera con lo que haya en esa cuenta: ese es todo el riesgo que existe.

## 3. La clave API — la parte que importa

En **Settings → API → Create API key**.

### Permisos a habilitar

- `Query Funds`
- `Query Open Orders & Trades`
- `Query Closed Orders & Trades`
- `Create & Modify Orders`
- `Cancel/Close Orders`

### Permiso a DEJAR APAGADO

- **`Withdraw Funds`** — nunca lo habilites.

Esto es lo que convierte la cuenta en una caja aislada. Sin ese permiso, aunque
la clave se filtre entera y alguien la use, **no puede sacar un peso**: solo
puede comprar y vender adentro de tu propia cuenta.

### Restriccion por IP

Si vas a correr el bot desde una IP fija (un VPS), agregala en el campo de IPs
permitidas. Si lo corres desde tu casa con IP dinamica, dejalo vacio.

### Guardar las credenciales

Kraken te muestra el **API Key** y el **Private Key** una sola vez. Copialos a tu
`.env`:

```bash
KRAKEN_API_KEY=tu_api_key
KRAKEN_API_SECRET=tu_private_key
```

El `.env` esta en `.gitignore` y nunca se sube al repositorio. No lo pegues en
un chat, ni en un issue, ni en una captura de pantalla.

## 4. Probar antes de operar

```bash
# Verifica que la clave autentica y lee el saldo
MODE=dryrun npm run doctor

# Manda una orden real a Kraken con validate=true:
# Kraken corre TODAS sus validaciones (saldo, minimos, decimales) y NO la ejecuta
MODE=dryrun npm run once
```

Si eso sale limpio, tus credenciales, tus permisos y tus tamanos de orden son
correctos. Recien ahi tiene sentido `MODE=live`.

---

## Comisiones

El bot asume `FEE_RATE=0.004` (0,40%), el arancel **taker** del tramo base de
Kraken: menos de USD 10.000 de volumen en 30 dias. El bot usa ordenes a mercado,
que siempre son taker.

Una vuelta completa (comprar + vender) cuesta **0,80% mas el spread**. Es mucho:
el precio tiene que moverse casi un punto entero a tu favor solo para empatar.

Si tu volumen sube, revisa tu arancel real en **Settings → Fee schedule** y
ajusta `FEE_RATE`. A partir de USD 10.000 mensuales el taker baja a 0,35%.

Ver [COSTS.md](COSTS.md) para el analisis completo y como el bot usa este numero
para decidir si una operacion vale la pena.

## Sobre el par

Por defecto `XBTUSD`. Kraken le dice **XBT** a Bitcoin (notacion ISO 4217 para
activos no estatales), asi que el par de Bitcoin contra dolar se escribe asi, no
`BTCUSD`.

Alternativas: `ETHUSD`, `SOLUSD`. Cuanto menos liquido el par, mas ancho el
spread y peor le va a un bot que opera seguido.
