// Market conditions for a signal: volatility numbers a local server publishes from
// MT5 candles (market_volatility), high-impact news ahead, and gold session times.
import { supabase } from "../config/supabase.js";

const VOL_MAX_AGE_MS = 15 * 60 * 1000;
const NEWS_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const NEWS_CACHE_MS = 60 * 60 * 1000;
// News blocks the delayed hedge from 30 minutes after a release to 4 hours before one
const NEWS_AHEAD_MS = 4 * 3600 * 1000;
const NEWS_AFTER_MS = 30 * 60 * 1000;
const NEWS_CURRENCIES = { XAUUSD: ["USD"], GOLD: ["USD"], BTCUSD: ["USD"] };

let newsCache = { at: 0, events: [] };

/** Latest volatility row for the symbol, or null when none is fresh (no unit online). */
export const getVolatility = async (symbol) => {
  const { data, error } = await supabase
    .from("market_volatility")
    .select("*")
    .eq("symbol", symbol)
    .maybeSingle();
  if (error || !data) return null;
  if (Date.now() - new Date(data.computed_at).getTime() > VOL_MAX_AGE_MS) return null;
  return data;
};

const loadNews = async () => {
  if (Date.now() - newsCache.at < NEWS_CACHE_MS) return newsCache.events;
  try {
    const res = await fetch(NEWS_URL, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const events = await res.json();
    newsCache = { at: Date.now(), events: Array.isArray(events) ? events : [] };
  } catch (error) {
    // Keep the last good list; retry in 5 minutes instead of on every signal
    console.warn(`[market] News calendar unavailable: ${error.message}`);
    newsCache.at = Date.now() - NEWS_CACHE_MS + 5 * 60 * 1000;
  }
  return newsCache.events;
};

/** High-impact events for the symbol's currencies from 30 min ago to 4 h ahead. */
export const getUpcomingNews = async (symbol, now = new Date()) => {
  const currencies = NEWS_CURRENCIES[symbol] || ["USD"];
  const events = await loadNews();
  return events
    .filter((e) => e.impact === "High" && currencies.includes(e.country))
    .map((e) => ({ title: e.title, country: e.country, at: new Date(e.date) }))
    .filter((e) => e.at.getTime() >= now.getTime() - NEWS_AFTER_MS && e.at.getTime() <= now.getTime() + NEWS_AHEAD_MS)
    .map((e) => ({ title: e.title, country: e.country, at: e.at.toISOString() }));
};

const nyClock = (date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  return {
    weekday: parts.find((p) => p.type === "weekday").value,
    hour: Number(parts.find((p) => p.type === "hour").value),
  };
};

/** Gold trades Sunday 18:00 to Friday 17:00 New York, with a daily break 17:00-18:00. */
export const goldMarketOpen = (date = new Date()) => {
  const { weekday, hour } = nyClock(date);
  if (weekday === "Sat" || (weekday === "Sun" && hour < 18) || (weekday === "Fri" && hour >= 17)) return false;
  return hour !== 17;
};

/** 16:00-18:00 New York (23:00-01:00 broker time): thin market and wide spreads around the daily rollover. */
export const isRollover = (date = new Date()) => {
  const { hour } = nyClock(date);
  return hour === 16 || hour === 17;
};

/**
 * Support (lowest low) and resistance (highest high) of the recorded 1-minute
 * candles over the last `hours`, or null when too few minutes were recorded.
 */
export const getRecentRange = async (symbol, hours, now = new Date()) => {
  const from = new Date(now.getTime() - hours * 3600 * 1000);
  const base = () => supabase.from("market_candles").select("high, low").eq("symbol", symbol)
    .gte("minute", from.toISOString()).lt("minute", now.toISOString());
  const [top, bottom, count] = await Promise.all([
    base().order("high", { ascending: false }).limit(1).maybeSingle(),
    base().order("low", { ascending: true }).limit(1).maybeSingle(),
    supabase.from("market_candles").select("minute", { count: "exact", head: true }).eq("symbol", symbol)
      .gte("minute", from.toISOString()).lt("minute", now.toISOString()),
  ]);
  if (top.error || bottom.error || !top.data || !bottom.data) return null;
  let open = 0;
  for (let t = from.getTime(); t < now.getTime(); t += 60000) if (goldMarketOpen(new Date(t))) open++;
  const coverage = open ? (count.count ?? 0) / open : 0;
  if (coverage < 0.8) return null;
  const support = Number(bottom.data.low), resistance = Number(top.data.high);
  return { support, resistance, range: Math.round((resistance - support) * 100) / 100, coverage: Math.round(coverage * 100) / 100 };
};

/**
 * Support/resistance checks for the delayed hedge, saved with each signal and
 * graded with it — tracked only, not part of the score:
 *   sl_gt_range     the SL distance is wider than the support-resistance range
 *   trigger_beyond  the hedge trigger (10% of the SL against the trade) sits
 *                   below support for a buy / above resistance for a sell
 */
export const getSupportResistanceChecks = async (symbol, entry, direction, slDistance) => {
  const s = direction === "buy" ? 1 : -1;
  const trigger = entry - s * 0.1 * slDistance;
  const out = { entry, sl_distance: Math.round(slDistance * 100) / 100, trigger_price: Math.round(trigger * 100) / 100, checks: {} };
  for (const hours of [8, 24]) {
    const r = await getRecentRange(symbol, hours).catch(() => null);
    out[`h${hours}`] = r;
    if (!r) continue;
    out.checks[`sl_gt_range_${hours}h`] = slDistance > r.range;
    out.checks[`trigger_beyond_${hours}h`] = s === 1 ? trigger < r.support : trigger > r.resistance;
  }
  return out;
};

export const getMarketContext = async (symbol, now = new Date()) => {
  const [volatility, news] = await Promise.all([
    getVolatility(symbol).catch(() => null),
    getUpcomingNews(symbol, now).catch(() => []),
  ]);
  return { volatility, news, rollover: isRollover(now) };
};

const hhmm = (iso) => new Date(iso).toISOString().slice(11, 16);

/** A few short lines for the AI prompt (small models do worse with long context). */
export const describeContext = (ctx) => {
  const lines = [];
  const vol = ctx?.volatility;
  if (vol) {
    lines.push(`Expected move over the next 6 hours: about $${Number(vol.forecast_6h).toFixed(1)} per hour (normal for this hour: $${Number(vol.hour_norm).toFixed(1)})`);
    if (vol.ratio_now != null) lines.push(`Right now price is moving ${Number(vol.ratio_now).toFixed(1)}x the normal amount for this hour`);
  }
  if (ctx?.news?.length) {
    lines.push(`High-impact news: ${ctx.news.map((e) => `${e.country} ${e.title} at ${hhmm(e.at)} UTC`).join("; ")}`);
  }
  return lines;
};
