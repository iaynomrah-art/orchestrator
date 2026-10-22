import cron from "node-cron";
import { supabase } from "../config/supabase.js";
import { loadCandles } from "../helper/candleRecorder.js";

// Volatility numbers from the orchestrator's own 1-minute candles, so they stay
// live on the VPS without a local server. A local server publishing from MT5 takes
// precedence: this only writes when that row is more than STALE_MS old.
// Same method as the local server: recent $ move per hour x the usual pattern of
// the coming hours. On when SHADOW_SIGNALS_ENABLED=true.
const SYMBOL = "XAUUSD";
const STALE_MS = 10 * 60 * 1000;
const BASE_HOURS = 24;            // "recent level" window (the local server uses 5 days of MT5 history)
const MIN_BASE_RETURNS = 6 * 12;  // at least 6 hours of 5-minute moves
const SL_DISTANCE_MULT = 2.4;     // SL ~2.4x the expected hourly move -> median ~5h trades
// Gold's relative bumpiness by UTC hour (mean 1), from 8 months of HeroFX 5-minute candles
// (Feb-Oct 2026): busiest around the US data release (12-14 UTC), quietest 03-04 UTC
export const HOUR_PROFILE_UTC = [1.12, 1.30, 0.91, 0.70, 0.62, 0.95, 0.94, 0.89, 0.95, 0.85, 0.80, 1.26,
  1.41, 1.48, 1.42, 1.18, 1.09, 0.90, 1.03, 0.83, 0.74, 0.92, 0.84, 0.88];
let lastErrorLogAt = 0;

const std = (a) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

/** Volatility numbers from 1-minute candles ({minute: ms, close}), sorted by time. */
export const computeVolatility = (candles, nowMs) => {
  // 5-minute closes; a move only counts between back-to-back 5-minute buckets (no gaps)
  const buckets = new Map();
  for (const c of candles) buckets.set(Math.floor(c.minute / 300000), c.close);
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const moves = [];
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] - keys[i - 1] === 1) moves.push({ at: keys[i] * 300000, move: buckets.get(keys[i]) - buckets.get(keys[i - 1]) });
  }
  if (moves.length < MIN_BASE_RETURNS) return null;
  const sigmaBase = std(moves.map((m) => m.move)) * Math.sqrt(12);
  const lastHour = moves.filter((m) => m.at > nowMs - 3600 * 1000).map((m) => m.move);
  const sigma1h = lastHour.length >= 8 ? std(lastHour) * Math.sqrt(12) : null;
  const hour = new Date(nowMs).getUTCHours();
  const hourNorm = sigmaBase * HOUR_PROFILE_UTC[hour];
  const ahead = [1, 2, 3, 4, 5, 6].map((k) => HOUR_PROFILE_UTC[(hour + k) % 24]);
  const forecast = sigmaBase * (ahead.reduce((s, x) => s + x, 0) / ahead.length);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return {
    sigma_1h: sigma1h === null ? null : r3(sigma1h),
    sigma_5d: r3(sigmaBase),   // column name kept; here it is the last 24h
    hour_norm: r3(hourNorm),
    ratio_now: sigma1h && hourNorm ? r3(sigma1h / hourNorm) : null,
    forecast_6h: r3(forecast),
    suggested_sl_distance: Math.round(SL_DISTANCE_MULT * forecast * 100) / 100,
  };
};

async function publishVolatility() {
  if (process.env.SHADOW_SIGNALS_ENABLED !== "true") return;
  try {
    const { data: current } = await supabase.from("market_volatility").select("computed_at").eq("symbol", SYMBOL).maybeSingle();
    if (current && Date.now() - new Date(current.computed_at).getTime() < STALE_MS) return;   // a local server is publishing
    const now = Date.now();
    const vol = computeVolatility(await loadCandles(SYMBOL, now - BASE_HOURS * 3600 * 1000, now), now);
    if (!vol) return;   // not enough recorded candles yet (or the market is closed)
    const { error } = await supabase.from("market_volatility").upsert({
      symbol: SYMBOL, broker_symbol: SYMBOL, computed_at: new Date(now).toISOString(),
      server_offset_hours: 0, source: "VPS (TradingView candles)", ...vol,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    if (Date.now() - lastErrorLogAt > 3600 * 1000) {
      lastErrorLogAt = Date.now();
      console.error(`[volatility] Failed: ${error.message}`);
    }
  }
}

cron.schedule("*/5 * * * *", publishVolatility, { timezone: "UTC" });

export { publishVolatility };
