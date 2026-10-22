// Builds 1-minute candles from the price priceStreamer already fetches every 2
// seconds and saves each finished minute to market_candles. Lets the orchestrator
// grade shadow signals by itself on a Linux VPS, with no MT5. On when
// SHADOW_SIGNALS_ENABLED=true (needs migration_market_candles.sql).
import { supabase } from "../config/supabase.js";

const current = {};   // symbol -> the minute being built
let lastErrorLogAt = 0;

const save = async (symbol, c) => {
  const { error } = await supabase.from("market_candles").upsert({
    symbol,
    minute: new Date(c.minute).toISOString(),
    open: c.open, high: c.high, low: c.low, close: c.close, ticks: c.ticks,
  });
  if (error && Date.now() - lastErrorLogAt > 3600 * 1000) {
    lastErrorLogAt = Date.now();   // at most one log an hour (e.g. the migration hasn't run)
    console.error(`[candles] Could not save ${symbol} candle: ${error.message}`);
  }
};

export const recordPrice = (symbol, price, now = Date.now()) => {
  if (process.env.SHADOW_SIGNALS_ENABLED !== "true" || !(price > 0)) return;
  const minute = Math.floor(now / 60000) * 60000;
  const c = current[symbol];
  if (c && c.minute === minute) {
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.ticks++;
    return;
  }
  if (c) save(symbol, c).catch(() => {});
  current[symbol] = { minute, open: price, high: price, low: price, close: price, ticks: 1 };
};

/** Recorded 1-minute candles between two times (ms), oldest first. */
export const loadCandles = async (symbol, fromMs, toMs) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("market_candles")
      .select("minute, open, high, low, close")
      .eq("symbol", symbol)
      .gte("minute", new Date(fromMs).toISOString())
      .lt("minute", new Date(toMs).toISOString())
      .order("minute")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows.map((r) => ({ minute: new Date(r.minute).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
};
