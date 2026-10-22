import cron from "node-cron";
import { supabase } from "../config/supabase.js";
import { gradeAll, signalDistances } from "../helper/gradeHelper.js";
import { goldMarketOpen } from "../helper/marketContextHelper.js";

// Grades signals 8 hours after they were made, on the 1-minute candles the
// orchestrator records itself (candleRecorder), so shadow mode needs no MT5.
// A local server with MT5 may grade too; whichever grades a signal first wins.
// On when SHADOW_SIGNALS_ENABLED=true.
const HORIZON_SEC = 8 * 3600;
const LOOKBACK_DAYS = 14;
const MIN_COVERAGE = 0.8;          // share of open-market minutes that need a candle
const GIVE_UP_AFTER_MS = 24 * 3600 * 1000;
const SYMBOLS = { XAUUSD: ["XAUUSD", "GOLD"] };
let running = false;

const loadCandles = async (symbol, fromMs, toMs) => {
  const { data, error } = await supabase
    .from("market_candles")
    .select("minute, open, high, low, close")
    .eq("symbol", symbol)
    .gte("minute", new Date(fromMs).toISOString())
    .lt("minute", new Date(toMs).toISOString())
    .order("minute")
    .limit(1000);
  if (error) throw new Error(error.message);
  const candles = { time: [], open: [], high: [], low: [], close: [] };
  for (const r of data) {
    candles.time.push(Math.floor(new Date(r.minute).getTime() / 1000));
    candles.open.push(Number(r.open)); candles.high.push(Number(r.high));
    candles.low.push(Number(r.low)); candles.close.push(Number(r.close));
  }
  return candles;
};

const openMinutes = (fromMs, toMs) => {
  let n = 0;
  for (let t = fromMs; t < toMs; t += 60000) if (goldMarketOpen(new Date(t))) n++;
  return n;
};

/** The grade for one signal, or null to try again later / leave it to a local server. */
const gradeSignal = async (symbol, sig) => {
  const created = new Date(sig.created_at).getTime();
  const dist = signalDistances(sig);
  if (!dist) return { skipped: "broken levels" };

  const start = Math.floor(created / 60000) * 60000;
  const candles = await loadCandles(symbol, start, start + HORIZON_SEC * 1000);
  // No candle near the signal: it predates the recorder (or the orchestrator was
  // down) — leave it for a local server with MT5 history instead of skipping it
  if (!candles.time.length || candles.time[0] * 1000 - start > 10 * 60000) return null;

  const expected = openMinutes(start, start + HORIZON_SEC * 1000);
  const coverage = expected ? candles.time.length / expected : 1;
  if (coverage < MIN_COVERAGE) {
    return Date.now() - created > GIVE_UP_AFTER_MS ? { skipped: `price data gaps (${Math.round(coverage * 100)}% of minutes)` } : null;
  }

  const results = gradeAll(candles, 0, { ai: sig.direction, tv: sig.tv_direction, coin: sig.coin_direction }, dist.slD, dist.tpD, HORIZON_SEC);
  return {
    version: 1, grader: "orchestrator-tradingview-1m", horizon_h: HORIZON_SEC / 3600,
    entry_price: candles.open[0], coverage: Math.round(coverage * 100) / 100,
    sl_distance: Math.round(dist.slD * 1000) / 1000, tp_distance: Math.round(dist.tpD * 1000) / 1000, results,
  };
};

async function gradePendingSignals() {
  if (process.env.SHADOW_SIGNALS_ENABLED !== "true" || running) return;
  running = true;
  try {
    const now = Date.now();
    for (const [symbol, names] of Object.entries(SYMBOLS)) {
      const { data: rows, error } = await supabase
        .from("market_signals")
        .select("id, created_at, direction, tv_direction, coin_direction, entry_price, stop_price, target_price")
        .is("graded_at", null)
        .in("symbol", names)
        .lte("created_at", new Date(now - (HORIZON_SEC + 600) * 1000).toISOString())
        .gte("created_at", new Date(now - LOOKBACK_DAYS * 86400000).toISOString())
        .order("created_at")
        .limit(200);
      if (error) throw new Error(error.message);

      let graded = 0;
      for (const sig of rows) {
        const grade = await gradeSignal(symbol, sig);
        if (!grade) continue;
        const { error: updateError } = await supabase.from("market_signals")
          .update({ grade, graded_at: new Date().toISOString() })
          .eq("id", sig.id).is("graded_at", null);
        if (!updateError) graded++;
      }
      if (graded) console.log(`[grade] Graded ${graded} ${symbol} signal(s) on recorded candles`);
    }
  } catch (error) {
    console.error(`[grade] Failed: ${error.message}`);
  } finally {
    running = false;
  }
}

cron.schedule("*/30 * * * *", gradePendingSignals, { timezone: "UTC" });

export { gradePendingSignals, gradeSignal };
