// "Last 6 hours of 5-minute candles" summary for the AI prompt: which way price
// went, how many candles were bullish, the high/low structure, and where price
// sits in the range. Used live (from market_candles) and by the replay (from MT5).
import { loadCandles } from "./candleRecorder.js";

export const CANDLE_HOURS = 6;
const BAR_SEC = 300;

/** 5-minute bars ({time, open, high, low, close}, oldest first) from 1-minute candles. */
export const toFiveMinute = (oneMinute) => {
  const bars = [];
  for (const c of oneMinute) {
    const t = Math.floor(c.minute / (BAR_SEC * 1000)) * BAR_SEC;
    const last = bars[bars.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close;
    } else {
      bars.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
    }
  }
  return bars;
};

/** Summary of the last 6 hours of 5-minute bars, or null if too few (market closed, recorder down). */
export const summarizeCandles = (bars) => {
  if (!bars || bars.length < CANDLE_HOURS * 12 * 0.7) return null;
  const first = bars[0], last = bars[bars.length - 1];
  const high = Math.max(...bars.map((b) => b.high)), low = Math.min(...bars.map((b) => b.low));
  const bullish = bars.filter((b) => b.close > b.open).length;
  // Structure: highs and lows of the last 2 hours vs the 2 hours before them
  const cut = last.time - 2 * 3600, cut2 = last.time - 4 * 3600;
  const recent = bars.filter((b) => b.time > cut), before = bars.filter((b) => b.time > cut2 && b.time <= cut);
  let structure = "mixed (ranging)";
  if (recent.length && before.length) {
    const hh = Math.max(...recent.map((b) => b.high)) > Math.max(...before.map((b) => b.high));
    const hl = Math.min(...recent.map((b) => b.low)) > Math.min(...before.map((b) => b.low));
    if (hh && hl) structure = "higher highs and higher lows (uptrend)";
    else if (!hh && !hl) structure = "lower highs and lower lows (downtrend)";
  }
  const hourAgo = bars.find((b) => b.time >= last.time - 3600) || first;
  const r2 = (x) => Math.round(x * 100) / 100;
  const rangePos = high > low ? Math.round(((last.close - low) / (high - low)) * 100) : 50;

  // Real Candlestick Price Action Analysis at Boundaries (wicks & momentum)
  const prev = bars.length >= 2 ? bars[bars.length - 2] : last;
  const candleRange = Math.max(0.01, last.high - last.low);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWickPct = Math.round((lowerWick / candleRange) * 100);
  const upperWickPct = Math.round((upperWick / candleRange) * 100);

  let boundaryAction = "neutral";
  if (rangePos <= 25) {
    if (lowerWickPct >= 35 || (last.close > last.open && prev.close < prev.open)) {
      boundaryAction = "support_bounce_wick";
    } else if (structure.includes("downtrend") || (last.close < last.open && lowerWickPct < 20)) {
      boundaryAction = "breakdown_momentum";
    } else {
      boundaryAction = "testing_support";
    }
  } else if (rangePos >= 75) {
    if (upperWickPct >= 35 || (last.close < last.open && prev.close > prev.open)) {
      boundaryAction = "resistance_rejection_wick";
    } else if (structure.includes("uptrend") || (last.close > last.open && upperWickPct < 20)) {
      boundaryAction = "breakout_momentum";
    } else {
      boundaryAction = "testing_resistance";
    }
  }

  return {
    from: r2(first.open), to: r2(last.close), change: r2(last.close - first.open),
    bullish_pct: Math.round((bullish / bars.length) * 100),
    structure,
    last_hour_change: r2(last.close - hourAgo.open),
    range_low: r2(low), range_high: r2(high),
    range_position_pct: rangePos,
    boundary_action: boundaryAction,
    lower_wick_pct: lowerWickPct,
    upper_wick_pct: upperWickPct,
  };
};

const signed = (x) => `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(2)}`;

export const describeCandles = (s) => {
  if (!s) return [];
  const span = Math.round((s.range_high - s.range_low) * 100) / 100;
  
  let zone = "MIDDLE OF RANGE (Consolidation)";
  if (s.boundary_action === "support_bounce_wick") {
    zone = "AT SUPPORT FLOOR: Buyer rejection wick detected (Defending floor)";
  } else if (s.boundary_action === "breakdown_momentum") {
    zone = "AT SUPPORT FLOOR: Bearish breakdown momentum (High risk of breaking lower)";
  } else if (s.boundary_action === "resistance_rejection_wick") {
    zone = "AT RESISTANCE CEILING: Seller rejection wick detected (Defending ceiling)";
  } else if (s.boundary_action === "breakout_momentum") {
    zone = "AT RESISTANCE CEILING: Bullish breakout momentum (High risk of breaking higher)";
  } else if (s.range_position_pct <= 25) {
    zone = "TESTING SUPPORT (Near range floor)";
  } else if (s.range_position_pct >= 75) {
    zone = "TESTING RESISTANCE (Near range ceiling)";
  }

  return [
    `Price moved ${signed(s.change)} (${s.from.toFixed(2)} -> ${s.to.toFixed(2)}); ${s.bullish_pct}% of candles were bullish`,
    `Market Structure: ${s.structure.toUpperCase()}`,
    `6-Hour Range: Support Floor = $${s.range_low.toFixed(2)}, Resistance Ceiling = $${s.range_high.toFixed(2)} (Span: $${span.toFixed(2)})`,
    `Current Price Location: ${s.range_position_pct}% of range [${zone}]`,
    `Last hour move: ${signed(s.last_hour_change)}`,
  ];
};

/** Live: the summary from the orchestrator's recorded 1-minute candles. */
export const getCandleSummary = async (symbol, now = Date.now()) => {
  const rows = await loadCandles(symbol, now - CANDLE_HOURS * 3600 * 1000, now);
  return summarizeCandles(toFiveMinute(rows));
};
