import "dotenv/config";
import { z } from "zod";

/**
 * Toda la configuracion del bot vive en variables de entorno y se valida al arrancar.
 * Si algo esta mal, el proceso muere aca y no cuando ya hay plata en juego.
 */

/** Lee un booleano de una variable de entorno, aceptando las grafias habituales. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? fallback : ["1", "true", "yes", "si", "on"].includes(v.trim().toLowerCase()),
    );

const schema = z.object({
  // --- Modo de ejecucion -----------------------------------------------
  /**
   * paper  = simulador local con precios reales de mercado. No toca el exchange.
   * live   = ordenes reales contra Kraken.
   * dryrun = firma y envia la orden a Kraken con validate=true: el exchange la
   *          valida (saldo, minimos, decimales) pero NO la ejecuta.
   */
  MODE: z.enum(["paper", "dryrun", "live"]).default("paper"),

  // --- Mercado ---------------------------------------------------------
  /** Par en notacion Kraken. XBTUSD = Bitcoin contra dolar. */
  PAIR: z.string().default("XBTUSD"),
  /** Minutos por vela. Kraken admite 1, 5, 15, 30, 60, 240, 1440. */
  CANDLE_INTERVAL_MIN: z.coerce.number().int().positive().default(15),
  /** Cada cuantos segundos corre un ciclo de decision. */
  LOOP_INTERVAL_SEC: z.coerce.number().int().positive().default(300),

  // --- Capital y tamano de posicion ------------------------------------
  /** Capital inicial del simulador en paper mode (USD). */
  PAPER_STARTING_CASH: z.coerce.number().positive().default(1000),
  /** Porcentaje del equity que puede entrar en una sola posicion (0-1). */
  MAX_POSITION_PCT: z.coerce.number().min(0).max(1).default(0.25),
  /** Valor minimo de una orden en USD. Debajo de esto no vale la pena por fees. */
  MIN_ORDER_USD: z.coerce.number().positive().default(10),

  // --- Riesgo ----------------------------------------------------------
  /** Stop loss como multiplo del ATR. */
  STOP_ATR_MULT: z.coerce.number().positive().default(2),
  /** Take profit como multiplo del ATR. */
  TAKE_PROFIT_ATR_MULT: z.coerce.number().positive().default(3),
  /** Distancia maxima del stop respecto de la entrada, pase lo que pase con el ATR (0-1). */
  HARD_STOP_PCT: z.coerce.number().min(0).max(1).default(0.05),
  /**
   * Cuanto del equity total se arriesga en UNA operacion (0-1).
   *
   * Es distinto de HARD_STOP_PCT y tiene que ser bastante menor. HARD_STOP_PCT
   * dice a que distancia esta el stop; este dice cuanta plata estamos dispuestos
   * a perder si ese stop se ejecuta. De la division de los dos sale el tamano de
   * la posicion: con el stop al 5% y riesgo del 1%, la posicion es el 20% del
   * equity. Asi, cuando la volatilidad aleja el stop, la posicion entra mas chica
   * sola, sin que nadie toque un parametro.
   */
  RISK_PER_TRADE_PCT: z.coerce.number().min(0).max(1).default(0.01),
  /** Trailing stop: cuanto retrocede desde el maximo antes de cerrar (0-1). */
  TRAILING_STOP_PCT: z.coerce.number().min(0).max(1).default(0.03),
  /** Perdida diaria que frena el bot por el resto del dia (0-1). */
  DAILY_LOSS_LIMIT_PCT: z.coerce.number().min(0).max(1).default(0.03),
  /** Drawdown total desde el pico que apaga el bot del todo (0-1). */
  MAX_DRAWDOWN_PCT: z.coerce.number().min(0).max(1).default(0.15),
  /** Cantidad maxima de operaciones por dia. */
  MAX_TRADES_PER_DAY: z.coerce.number().int().positive().default(6),
  /** Minutos de espera obligatoria despues de cerrar una posicion. */
  COOLDOWN_MIN: z.coerce.number().min(0).default(30),
  /** Horas maximas que se puede sostener una posicion abierta. */
  MAX_HOLDING_HOURS: z.coerce.number().positive().default(72),
  /** Spread maximo tolerado en bps. Por encima, no se opera. */
  MAX_SPREAD_BPS: z.coerce.number().positive().default(20),

  // --- Umbrales de decision sobre la salida de Jev ----------------------
  /** Probabilidad minima de la accion elegida para abrir una posicion (0-1). */
  MIN_BUY_PROBABILITY: z.coerce.number().min(0).max(1).default(0.6),
  /** Confianza minima que debe reportar Jev para abrir (0-1). */
  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.55),
  /** Conviccion minima en la rubrica 0-4 para abrir. */
  MIN_CONVICTION: z.coerce.number().min(0).max(4).default(2),
  /** Probabilidad de riesgo por encima de la cual no se abre nada (0-1). */
  MAX_RISK_PROBABILITY: z.coerce.number().min(0).max(1).default(0.5),
  /** Probabilidad de salida por encima de la cual se cierra la posicion (0-1). */
  EXIT_PROBABILITY: z.coerce.number().min(0).max(1).default(0.65),

  // --- Credenciales ----------------------------------------------------
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: z.string().default("jev-latest"),
  KRAKEN_API_KEY: z.string().optional(),
  KRAKEN_API_SECRET: z.string().optional(),

  // --- Operacion -------------------------------------------------------
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Comision estimada por operacion (0.0026 = 0.26%, el taker fee base de Kraken). */
  FEE_RATE: z.coerce.number().min(0).max(0.1).default(0.0026),
  /** Slippage asumido en el simulador, en bps. */
  PAPER_SLIPPAGE_BPS: z.coerce.number().min(0).default(5),
  /** Si es true, el bot puede abrir posiciones. Si es false, solo cierra. */
  ALLOW_ENTRIES: boolish(true),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuracion invalida:\n${issues}`);
  }
  const cfg = parsed.data;

  // Coherencia entre parametros: un take profit por debajo del stop no tiene sentido.
  if (cfg.TAKE_PROFIT_ATR_MULT <= cfg.STOP_ATR_MULT) {
    throw new Error(
      `TAKE_PROFIT_ATR_MULT (${cfg.TAKE_PROFIT_ATR_MULT}) debe ser mayor que ` +
        `STOP_ATR_MULT (${cfg.STOP_ATR_MULT}): si no, cada trade arriesga mas de lo que busca ganar.`,
    );
  }
  if (cfg.RISK_PER_TRADE_PCT >= cfg.HARD_STOP_PCT) {
    throw new Error(
      `RISK_PER_TRADE_PCT (${cfg.RISK_PER_TRADE_PCT}) debe ser menor que HARD_STOP_PCT ` +
        `(${cfg.HARD_STOP_PCT}): si no, el tope de riesgo por operacion nunca llega a ` +
        `limitar el tamano y el ajuste por volatilidad queda sin efecto.`,
    );
  }
  if (cfg.DAILY_LOSS_LIMIT_PCT >= cfg.MAX_DRAWDOWN_PCT) {
    throw new Error(
      `DAILY_LOSS_LIMIT_PCT (${cfg.DAILY_LOSS_LIMIT_PCT}) debe ser menor que ` +
        `MAX_DRAWDOWN_PCT (${cfg.MAX_DRAWDOWN_PCT}): el freno diario tiene que saltar antes que el apagado total.`,
    );
  }
  if (cfg.MODE !== "paper") {
    if (!cfg.KRAKEN_API_KEY || !cfg.KRAKEN_API_SECRET) {
      throw new Error(
        `MODE=${cfg.MODE} necesita KRAKEN_API_KEY y KRAKEN_API_SECRET. ` +
          `Usa MODE=paper para operar sin credenciales.`,
      );
    }
  }
  return cfg;
}
