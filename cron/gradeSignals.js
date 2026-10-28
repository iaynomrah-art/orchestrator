import cron from "node-cron";
import { supabase } from "../config/supabase.js";
import { gradeAll, signalDistances, walk } from "../helper/gradeHelper.js";
import { goldMarketOpen } from "../helper/marketContextHelper.js";
import { loadCandles as loadRecorded } from "../helper/candleRecorder.js";

// Grades signals on the 1-minute candles the orchestrator records itself
// (candleRecorder), so shadow mode needs no MT5. On when SHADOW_SIGNALS_ENABLED=true.
//   - Rule signals (inputs.rule with a lot and SL distance: the S/R bounce) are graded
//     like the replay: held until SL or TP (up to HOLD_DAYS), at the rule's lot, TP and
//     hedge trigger, with overnight swaps (grade.results.<side>.main). They're graded
//     once they close; a local server's 8-hour grade is replaced.
//   - Other signals: 8 hours after they were made, at the 10% / 15% settings.
const HORIZON_SEC = 8 * 3600;
const HOLD_DAYS = 15;
const HOLD_SEC = HOLD_DAYS * 86400;
const LOOKBACK_DAYS = HOLD_DAYS + 2;
const MIN_COVERAGE = 0.8;          // share of open-market minutes that need a candle
const GIVE_UP_AFTER_MS = 24 * 3600 * 1000;
const SYMBOLS = { XAUUSD: ["XAUUSD", "GOLD"] };
const RULE_GRADER = "orchestrator-rule-1m";
// Overnight swap, $ per 1.0 lot per night: HeroFX XAUUSD.r (same as scripts/replayRules.js)
const SWAP = { buy: -130.55, sell: 8.6 };
const MAX_LOSS_DOLLARS = 20;
let running = false;

/** Recorded 1-minute candles as arrays (time in seconds), paged so multi-day holds fit. */
const loadCandles = async (symbol, fromMs, toMs) => {
  const rows = await loadRecorded(symbol, fromMs, toMs);
  const candles = { time: [], open: [], high: [], low: [], close: [] };
  for (const r of rows) {
    candles.time.push(Math.floor(r.minute / 1000));
    candles.open.push(r.open); candles.high.push(r.high); candles.low.push(r.low); candles.close.push(r.close);
  }
  return candles;
};

const openMinutes = (fromMs, toMs) => {
  let n = 0;
  for (let t = fromMs; t < toMs; t += 60000) if (goldMarketOpen(new Date(t))) n++;
  return n;
};

// Broker rollover (and swap) at 17:00 New York, Monday to Friday; Wednesday's counts 3 nights
const nyClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23", weekday: "short" });
const rolloverNights = (fromSec, toSec) => {
  let n = 0;
  for (let t = Math.ceil(fromSec / 3600) * 3600; t <= toSec; t += 3600) {
    const parts = Object.fromEntries(nyClock.formatToParts(new Date(t * 1000)).map((p) => [p.type, p.value]));
    if (Number(parts.hour) !== 17) continue;
    n += parts.weekday === "Wed" ? 3 : ["Mon", "Tue", "Thu", "Fri"].includes(parts.weekday) ? 1 : 0;
  }
  return n;
};

/** The rule's levels and sizing from a signal, or null when it isn't a rule signal. */
const ruleOf = (sig) => {
  const r = sig.inputs?.rule;
  const lot = Number(r?.lot), slD = Number(r?.sl_distance), tpD = Number(r?.tp_distance);
  if (!(lot > 0 && slD > 0 && tpD > 0) || !Number.isFinite(Number(r.support)) || !Number.isFinite(Number(r.resistance))) return null;
  return { lot, slD, tpD, support: Number(r.support), resistance: Number(r.resistance) };
};

/**
 * Rule signal, held until SL or TP: the grade, null to try again later (still open,
 * or no candles yet), or { skipped } when the price data has gaps.
 */
const gradeRuleSignal = async (symbol, sig, rule) => {
  const created = new Date(sig.created_at).getTime();
  const start = Math.floor(created / 60000) * 60000;
  const until = Math.min(Date.now(), start + HOLD_SEC * 1000);
  const candles = await loadCandles(symbol, start, until);
  if (!candles.time.length || candles.time[0] * 1000 - start > 10 * 60000) return null;

  const expected = openMinutes(start, until);
  const coverage = expected ? candles.time.length / expected : 1;
  if (coverage < MIN_COVERAGE) {
    return Date.now() - created > GIVE_UP_AFTER_MS ? { skipped: `price data gaps (${Math.round(coverage * 100)}% of minutes)` } : null;
  }

  const entry = candles.open[0], t0 = candles.time[0];
  const finished = until >= start + HOLD_SEC * 1000;
  const maxTrig = (MAX_LOSS_DOLLARS - 80 * rule.lot) / (rule.lot * 100);
  // Each side's own trigger: $0.50 past its S/R level, at least $2.50 and at most the $20 cap
  const side = (dir) => {
    if (dir !== "buy" && dir !== "sell") return null;
    const raw = dir === "buy" ? rule.support - 0.5 : rule.resistance + 0.5;
    const trigger = Math.max(0.01, Math.min(0.99, Math.max(2.5, Math.min(Math.abs(entry - raw), maxTrig)) / rule.slD));
    const w = walk(candles, 0, dir, rule.slD, rule.tpD, trigger, HOLD_SEC, { carryWeekend: true });
    const closeAt = w.hours != null ? t0 + w.hours * 3600 : t0 + HOLD_SEC;
    const opp = dir === "buy" ? "sell" : "buy";
    const r2 = (v) => Math.round(v * 100) / 100;
    const swap = {
      primary: r2(rolloverNights(t0, closeAt) * SWAP[dir] * rule.lot),
      hedge: w.hedge ? r2(rolloverNights(t0 + w.hedge.hours * 3600, closeAt) * SWAP[opp] * rule.lot) : 0,
      opposite_full: r2(rolloverNights(t0, closeAt) * SWAP[opp] * rule.lot),
    };
    return { ...w, trigger, swap };
  };

  const main = side(sig.direction);
  if (!main) return { skipped: "no direction" };
  if (main.story === "X" && !finished) return null;   // still open: grade it once it closes

  const results = gradeAll(candles, 0, { ai: sig.direction, tv: sig.tv_direction, coin: sig.coin_direction }, rule.slD, rule.tpD, HORIZON_SEC);
  results.ai.main = main;
  for (const [src, dir] of [["tv", sig.tv_direction], ["coin", sig.coin_direction]]) {
    const g = side(dir);
    if (g && results[src]) results[src].main = g;
  }
  results.opp = { main: side(sig.direction === "buy" ? "sell" : "buy") };
  return {
    version: 2, grader: RULE_GRADER, hold_days: HOLD_DAYS,
    entry_price: entry, mark_price: candles.close[candles.close.length - 1], coverage: Math.round(coverage * 100) / 100,
    sl_distance: rule.slD, tp_distance: rule.tpD, lot: rule.lot, results,
  };
};

/** The 8-hour grade for one signal, or null to try again later / leave it to a local server. */
const gradeSignal = async (symbol, sig) => {
  const rule = ruleOf(sig);
  if (rule) return gradeRuleSignal(symbol, sig, rule);

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
      // Ungraded signals, plus rule signals that only have another grader's grade (an 8-hour
      // one, or a "skipped" one from before rule signals saved their stop price)
      const { data: rows, error } = await supabase
        .from("market_signals")
        .select("id, created_at, direction, tv_direction, coin_direction, entry_price, stop_price, target_price, graded_at, grade, inputs")
        .or(`graded_at.is.null,and(inputs->rule->>lot.not.is.null,or(grade->>grader.is.null,grade->>grader.neq.${RULE_GRADER}))`)
        .in("symbol", names)
        .lte("created_at", new Date(now - (HORIZON_SEC + 600) * 1000).toISOString())
        .gte("created_at", new Date(now - LOOKBACK_DAYS * 86400000).toISOString())
        .order("created_at")
        .limit(200);
      if (error) throw new Error(error.message);

      let graded = 0;
      for (const sig of rows) {
        if (sig.graded_at && !ruleOf(sig)) continue;
        const grade = await gradeSignal(symbol, sig);
        if (!grade) continue;
        // Rule grades replace another grader's; otherwise the first grade wins
        let query = supabase.from("market_signals").update({ grade, graded_at: new Date().toISOString() }).eq("id", sig.id);
        if (!sig.graded_at) query = query.is("graded_at", null);
        const { error: updateError } = await query;
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
