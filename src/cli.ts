import { runBacktest } from "./backtest/runner.js";
import { HeuristicBrain } from "./brain/heuristic.js";
import { JevBrain, type Brain } from "./brain/jev.js";
import { KrakenBroker } from "./broker/kraken.js";
import { PaperBroker } from "./broker/paper.js";
import type { Broker } from "./broker/types.js";
import { loadConfig, type Config } from "./config.js";
import { TradingEngine } from "./engine.js";
import { Logger } from "./logger.js";
import { KrakenPublicClient, fetchHistory } from "./marketdata/kraken-public.js";
import { StateStore, dailyPnlPct, drawdownPct } from "./state/store.js";

function brainFor(cfg: Config, forceHeuristic = false): Brain {
  if (forceHeuristic || !cfg.TYPESAFE_API_KEY) return new HeuristicBrain();
  return new JevBrain({ apiKey: cfg.TYPESAFE_API_KEY, model: cfg.TYPESAFE_MODEL });
}

async function brokerFor(cfg: Config, market: KrakenPublicClient): Promise<Broker> {
  if (cfg.MODE === "paper") {
    return new PaperBroker({
      startingCash: cfg.PAPER_STARTING_CASH,
      feeRate: cfg.FEE_RATE,
      slippageBps: cfg.PAPER_SLIPPAGE_BPS,
      rules: await market.getPairRules(cfg.PAIR),
    });
  }
  return new KrakenBroker({
    apiKey: cfg.KRAKEN_API_KEY!,
    apiSecret: cfg.KRAKEN_API_SECRET!,
    pair: cfg.PAIR,
    dryRun: cfg.MODE === "dryrun",
  });
}

async function buildEngine(cfg: Config, logger: Logger): Promise<TradingEngine> {
  const market = new KrakenPublicClient();
  const broker = await brokerFor(cfg, market);
  return new TradingEngine({
    cfg,
    logger,
    market,
    broker,
    brain: brainFor(cfg),
    store: new StateStore(cfg.DATA_DIR),
  });
}

/** Revisa que todo lo necesario este en su lugar antes de operar. */
async function doctor(cfg: Config, logger: Logger): Promise<number> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const market = new KrakenPublicClient();

  try {
    const quote = await market.getQuote(cfg.PAIR);
    checks.push({
      name: "Datos de mercado (Kraken publico)",
      ok: quote.last > 0,
      detail: `${cfg.PAIR} en ${quote.last} (bid ${quote.bid} / ask ${quote.ask})`,
    });
  } catch (err) {
    checks.push({
      name: "Datos de mercado (Kraken publico)",
      ok: false,
      detail: String(err instanceof Error ? err.message : err),
    });
  }

  try {
    const candles = await market.getCandles(cfg.PAIR, cfg.CANDLE_INTERVAL_MIN);
    checks.push({
      name: "Velas historicas",
      ok: candles.length >= 30,
      detail: `${candles.length} velas de ${cfg.CANDLE_INTERVAL_MIN}m`,
    });
  } catch (err) {
    checks.push({
      name: "Velas historicas",
      ok: false,
      detail: String(err instanceof Error ? err.message : err),
    });
  }

  if (cfg.TYPESAFE_API_KEY) {
    try {
      const models = await new JevBrain({
        apiKey: cfg.TYPESAFE_API_KEY,
        model: cfg.TYPESAFE_MODEL,
      }).listModels();
      checks.push({
        name: "Jev (TypeSafe AI)",
        ok: models.length > 0,
        detail: `modelos disponibles: ${models.map((m) => m.name).join(", ")}`,
      });
    } catch (err) {
      checks.push({
        name: "Jev (TypeSafe AI)",
        ok: false,
        detail: String(err instanceof Error ? err.message : err),
      });
    }
  } else {
    checks.push({
      name: "Jev (TypeSafe AI)",
      ok: false,
      detail: "Sin TYPESAFE_API_KEY: el bot usara el cerebro heuristico de reserva",
    });
  }

  if (cfg.MODE !== "paper") {
    try {
      const broker = new KrakenBroker({
        apiKey: cfg.KRAKEN_API_KEY!,
        apiSecret: cfg.KRAKEN_API_SECRET!,
        pair: cfg.PAIR,
        dryRun: cfg.MODE === "dryrun",
      });
      const balance = await broker.ping();
      checks.push({
        name: "Cuenta Kraken (clave privada)",
        ok: true,
        detail: `saldo: ${balance.cash.toFixed(2)} USD + ${balance.base} en activo base`,
      });
    } catch (err) {
      checks.push({
        name: "Cuenta Kraken (clave privada)",
        ok: false,
        detail: String(err instanceof Error ? err.message : err),
      });
    }
  } else {
    checks.push({
      name: "Cuenta Kraken (clave privada)",
      ok: true,
      detail: "MODE=paper: no se usan credenciales",
    });
  }

  console.log(`\n  Modo: ${cfg.MODE}   Par: ${cfg.PAIR}   Velas: ${cfg.CANDLE_INTERVAL_MIN}m\n`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "[ok]  " : "[FALLA]"} ${c.name}\n          ${c.detail}`);
  }
  const failures = checks.filter((c) => !c.ok && c.name !== "Jev (TypeSafe AI)").length;
  console.log(
    failures === 0
      ? "\n  Todo listo para operar.\n"
      : `\n  ${failures} problema(s) que hay que resolver antes de operar.\n`,
  );
  return failures === 0 ? 0 : 1;
}

async function status(cfg: Config): Promise<void> {
  const store = new StateStore(cfg.DATA_DIR);
  if (!store.exists()) {
    console.log(`\n  No hay estado guardado todavia en ${store.filePath}.\n`);
    return;
  }
  const state = store.load(cfg.PAPER_STARTING_CASH);
  const market = new KrakenPublicClient();
  const quote = await market.getQuote(cfg.PAIR);

  const base = state.paper?.base ?? state.position?.quantity ?? 0;
  const cash = state.paper?.cash ?? 0;
  const equity = cash + base * quote.last;

  console.log(`\n  Estado del bot  (${cfg.MODE})`);
  console.log(`  Archivo: ${store.filePath}\n`);
  console.log(`  Precio ${cfg.PAIR}: ${quote.last}`);
  if (state.paper) console.log(`  Equity: ${equity.toFixed(2)} USD  (efectivo ${cash.toFixed(2)})`);
  console.log(`  Pico de equity: ${state.equityPeak.toFixed(2)} USD`);
  console.log(`  Drawdown actual: ${drawdownPct(state, equity).toFixed(2)}%`);
  console.log(`  Resultado del dia: ${dailyPnlPct(state, equity).toFixed(2)}%`);
  console.log(`  Operaciones hoy: ${state.tradesToday}`);
  console.log(`  Perdidas seguidas: ${state.consecutiveLosses}`);

  if (state.position) {
    const p = state.position;
    const pnl = ((quote.last - p.entryPrice) / p.entryPrice) * 100;
    console.log(`\n  POSICION ABIERTA`);
    console.log(`    Cantidad: ${p.quantity}`);
    console.log(`    Entrada:  ${p.entryPrice.toFixed(2)}`);
    console.log(`    Stop:     ${p.stopPrice.toFixed(2)}`);
    console.log(`    Objetivo: ${p.targetPrice.toFixed(2)}`);
    console.log(`    No realizado: ${pnl.toFixed(2)}%`);
  } else {
    console.log(`\n  Sin posicion abierta.`);
  }

  if (state.killSwitch.active) {
    console.log(`\n  CORTA-CORRIENTE ACTIVO: ${state.killSwitch.reason}`);
    console.log(`  Reactivar con: npm run -- reset-kill-switch\n`);
  }

  const closed = state.closedTrades;
  if (closed.length > 0) {
    const wins = closed.filter((t) => t.pnlUsd > 0).length;
    const total = closed.reduce((a, t) => a + t.pnlUsd, 0);
    console.log(`\n  Operaciones cerradas: ${closed.length}  |  ganadoras: ${wins}`);
    console.log(`  Resultado acumulado: ${total.toFixed(2)} USD`);
    console.log(`\n  Ultimas 5:`);
    for (const t of closed.slice(-5)) {
      console.log(
        `    ${new Date(t.exitTime).toISOString().slice(0, 16)}  ${t.reason.padEnd(16)} ` +
          `${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%  (${t.pnlUsd.toFixed(2)} USD)`,
      );
    }
  }
  console.log("");
}

async function backtest(cfg: Config, args: string[]): Promise<void> {
  const days = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 60);
  const useJev = args.includes("--jev");

  console.log(`\n  Descargando ${days} dias de velas de ${cfg.CANDLE_INTERVAL_MIN}m...`);
  const market = new KrakenPublicClient();
  const from = Date.now() - days * 24 * 3_600_000;
  const candles = await fetchHistory(market, cfg.PAIR, cfg.CANDLE_INTERVAL_MIN, from);
  const rules = await market.getPairRules(cfg.PAIR);
  console.log(`  ${candles.length} velas descargadas.`);

  if (useJev && !cfg.TYPESAFE_API_KEY) {
    throw new Error("--jev necesita TYPESAFE_API_KEY configurada");
  }
  if (useJev) {
    console.log(
      `  Usando Jev: son ${candles.length} llamadas al modelo, va a tardar y consumir credito.`,
    );
  }

  const result = await runBacktest({
    candles,
    cfg,
    rules,
    brain: brainFor(cfg, !useJev),
  });

  console.log(`\n  RESULTADO  (cerebro: ${useJev ? cfg.TYPESAFE_MODEL : "heuristico"})\n`);
  console.log(`    Capital inicial:   ${result.startEquity.toFixed(2)} USD`);
  console.log(`    Capital final:     ${result.endEquity.toFixed(2)} USD`);
  console.log(`    Rendimiento:       ${result.returnPct > 0 ? "+" : ""}${result.returnPct}%`);
  console.log(`    Comprar y esperar: ${result.buyAndHoldPct > 0 ? "+" : ""}${result.buyAndHoldPct}%`);
  console.log(`    Operaciones:       ${result.trades.length} (${result.wins} ganadoras, ${result.losses} perdedoras)`);
  console.log(`    Aciertos:          ${result.winRatePct}%`);
  console.log(`    Drawdown maximo:   ${result.maxDrawdownPct}%`);
  console.log(`    Comisiones:        ${result.totalFees.toFixed(2)} USD`);
  console.log(
    `\n  ${
      result.returnPct > result.buyAndHoldPct
        ? "La estrategia le gano a comprar y esperar en este periodo."
        : "Comprar y esperar habria rendido mas en este periodo."
    }`,
  );
  console.log(
    `\n  Recorda que un backtest mide un pasado que ya no se repite, y que estos\n` +
      `  resultados no incluyen huecos de precio ni ampliacion del spread.\n`,
  );
}

async function loop(cfg: Config, logger: Logger): Promise<void> {
  const engine = await buildEngine(cfg, logger);
  let stopping = false;

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.warn("apagando", {
      signal,
      note: "la posicion abierta queda como esta; usa `npm run flat` para cerrarla",
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("bot iniciado", {
    mode: cfg.MODE,
    pair: cfg.PAIR,
    interval: `${cfg.CANDLE_INTERVAL_MIN}m`,
    loopSec: cfg.LOOP_INTERVAL_SEC,
    broker: engine.currentState.killSwitch.active ? "CORTA-CORRIENTE ACTIVO" : "ok",
  });

  while (!stopping) {
    try {
      const result = await engine.runOnce();
      logger.info("ciclo", {
        action: result.action,
        detail: result.detail,
        equity: Number(result.equity.toFixed(2)),
        price: result.quote.last,
      });
    } catch (err) {
      // Un ciclo que falla no puede tumbar el bot: el mercado sigue y la posicion
      // abierta necesita que el proximo ciclo llegue para vigilar su stop.
      logger.error("ciclo fallido", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, cfg.LOOP_INTERVAL_SEC * 1000));
  }
  logger.info("bot detenido");
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`
  jev-bot-trading

    npm run doctor      Verifica configuracion, conexion a Kraken y a Jev
    npm run once        Ejecuta un solo ciclo de decision y sale
    npm run run         Ejecuta el bot en bucle continuo
    npm run status      Muestra posicion, resultados y estado del corta-corriente
    npm run flat        Cierra la posicion abierta a mercado, ahora
    npm run backtest    Backtest sobre historia reciente
                          -- --days=90        cuantos dias usar
                          -- --jev            usar Jev en vez del heuristico (consume credito)

    npx tsx src/cli.ts reset-kill-switch    Reactiva el bot tras un apagado de emergencia
`);
    return;
  }

  const cfg = loadConfig();
  const logger = new Logger(cfg.LOG_LEVEL);

  switch (command) {
    case "doctor":
      process.exitCode = await doctor(cfg, logger);
      return;
    case "status":
      await status(cfg);
      return;
    case "backtest":
      await backtest(cfg, args);
      return;
    case "once": {
      const engine = await buildEngine(cfg, logger);
      const result = await engine.runOnce();
      logger.info("ciclo", {
        action: result.action,
        detail: result.detail,
        equity: Number(result.equity.toFixed(2)),
      });
      return;
    }
    case "run":
      await loop(cfg, logger);
      return;
    case "flat": {
      const engine = await buildEngine(cfg, logger);
      const fill = await engine.flatten("manual");
      console.log(
        fill
          ? `\n  Posicion cerrada: ${fill.quantity} a ${fill.price}\n`
          : "\n  No habia posicion abierta.\n",
      );
      return;
    }
    case "reset-kill-switch": {
      const engine = await buildEngine(cfg, logger);
      engine.resetKillSwitch();
      console.log("\n  Corta-corriente desactivado. El bot puede volver a abrir posiciones.\n");
      return;
    }
    default:
      console.error(`Comando desconocido: ${command}. Proba 'help'.`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
