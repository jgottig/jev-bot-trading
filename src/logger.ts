type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logger minimo con salida JSON por linea. Elegimos JSON porque las corridas
 * largas se analizan despues con jq y no leyendolas a ojo.
 */
export class Logger {
  constructor(private readonly min: Level = "info") {}

  private emit(level: Level, msg: string, data?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.min]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
    if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug = (m: string, d?: Record<string, unknown>) => this.emit("debug", m, d);
  info = (m: string, d?: Record<string, unknown>) => this.emit("info", m, d);
  warn = (m: string, d?: Record<string, unknown>) => this.emit("warn", m, d);
  error = (m: string, d?: Record<string, unknown>) => this.emit("error", m, d);
}
