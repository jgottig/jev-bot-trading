import fs from "node:fs";
import path from "node:path";
import type { ExitReason, Fill, Position } from "../types.js";

/**
 * Estado persistente del bot.
 *
 * Se guarda en disco despues de cada operacion porque el proceso se puede caer,
 * reiniciar o actualizar en cualquier momento, y al volver tiene que saber si hay
 * una posicion abierta, cuanto perdio hoy y si el corta-corriente esta activado.
 * Un bot que arranca amnesico vuelve a operar contra sus propios limites.
 */
export interface BotState {
  version: 1;
  position: Position | null;
  /** Maximo historico del equity, base del calculo de drawdown. */
  equityPeak: number;
  /** Dia calendario en curso, en UTC, formato YYYY-MM-DD. */
  dayKey: string;
  equityAtDayStart: number;
  tradesToday: number;
  consecutiveLosses: number;
  lastTradeTime: number | null;
  /** Si se activa, el bot deja de abrir posiciones hasta que un humano lo resetee. */
  killSwitch: { active: boolean; reason: string | null; since: number | null };
  fills: Fill[];
  closedTrades: ClosedTrade[];
  equityCurve: { time: number; equity: number }[];
  /** Saldos del simulador, para retomar una corrida de paper tras un reinicio. */
  paper: { cash: number; base: number } | null;
  /** Costo acumulado en dolares de las consultas a Jev. */
  modelCostUsd: number;
  /** Cantidad de consultas al modelo, para calcular el costo por decision. */
  modelCalls: number;
}

export interface ClosedTrade {
  entryTime: number;
  exitTime: number;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  /** Resultado neto en USD, ya descontadas las comisiones de entrada y salida. */
  pnlUsd: number;
  pnlPct: number;
  reason: ExitReason;
}

export function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function emptyState(startingEquity: number, now = Date.now()): BotState {
  return {
    version: 1,
    position: null,
    equityPeak: startingEquity,
    dayKey: todayKey(now),
    equityAtDayStart: startingEquity,
    tradesToday: 0,
    consecutiveLosses: 0,
    lastTradeTime: null,
    killSwitch: { active: false, reason: null, since: null },
    fills: [],
    closedTrades: [],
    equityCurve: [],
    paper: null,
    modelCostUsd: 0,
    modelCalls: 0,
  };
}

export class StateStore {
  private readonly file: string;

  constructor(dataDir: string, fileName = "state.json") {
    this.file = path.join(dataDir, fileName);
  }

  get filePath(): string {
    return this.file;
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  load(startingEquity: number): BotState {
    if (!this.exists()) return emptyState(startingEquity);
    const raw = fs.readFileSync(this.file, "utf8");
    const parsed = JSON.parse(raw) as BotState;
    if (parsed.version !== 1) {
      throw new Error(`Estado en version ${parsed.version}, esperaba 1. Archivo: ${this.file}`);
    }
    // Campos agregados despues de la primera version del archivo.
    parsed.modelCostUsd ??= 0;
    parsed.modelCalls ??= 0;
    return parsed;
  }

  /**
   * Escribe a un temporal y despues renombra. Si el proceso muere a mitad de la
   * escritura, el archivo viejo queda intacto en vez de quedar truncado.
   */
  save(state: BotState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}

/** Arranca un dia nuevo si cambio la fecha, reseteando los contadores diarios. */
export function rollDay(state: BotState, equity: number, now = Date.now()): BotState {
  const key = todayKey(now);
  if (key === state.dayKey) return state;
  return {
    ...state,
    dayKey: key,
    equityAtDayStart: equity,
    tradesToday: 0,
  };
}

/** Resultado del dia en porcentaje, respecto del equity con que empezo. */
export function dailyPnlPct(state: BotState, equity: number): number {
  if (state.equityAtDayStart <= 0) return 0;
  return ((equity - state.equityAtDayStart) / state.equityAtDayStart) * 100;
}

/** Caida porcentual desde el maximo historico de equity. */
export function drawdownPct(state: BotState, equity: number): number {
  if (state.equityPeak <= 0) return 0;
  return ((state.equityPeak - equity) / state.equityPeak) * 100;
}
