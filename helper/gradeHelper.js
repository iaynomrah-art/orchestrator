// Grades a signal on the candles that followed it, with the delayed hedge rules
// and equal lots (same rules as the local server's market_data.walk):
//   A  TP before the trigger: the hedge never opens (the outcome we want)
//   B  trigger, then the primary's SL      C  trigger, then the primary's TP
//   X  neither within the horizon
// Candles: { time: [epoch seconds], open: [], high: [], low: [], close: [] }.

export const TRIGGERS = [0.1, 0.15];
const WEEKEND_GAP_SEC = 3 * 3600;

/** One direction at one setting. Up candle O->L->H->C, down candle O->H->L->C. */
export const walk = (candles, i0, direction, slD, tpD, trigger, horizonSec) => {
  const s = direction === "buy" ? 1 : -1;
  const p0 = candles.open[i0];
  const tp = p0 + s * tpD, sl = p0 - s * slD, trig = p0 - s * trigger * slD;
  const end = candles.time[i0] + horizonSec;
  const bar = candles.time.length > i0 + 1 ? candles.time[i0 + 1] - candles.time[i0] : 60;
  let hedged = false, worst = 0, hedge = null;
  for (let j = i0; j < candles.time.length && candles.time[j] < end; j++) {
    if (j > i0 && candles.time[j] - candles.time[j - 1] > WEEKEND_GAP_SEC) break;   // not carried over a weekend
    const o = candles.open[j], h = candles.high[j], l = candles.low[j], c = candles.close[j];
    const path = c >= o ? [o, l, h, c] : [o, h, l, c];
    for (let k = 0; k < path.length; k++) {
      const px = path[k];
      worst = Math.max(worst, ((p0 - px) * s) / slD);
      let story = null;
      if (!hedged) {
        if ((px - tp) * s >= 0) story = "A";
        else if ((trig - px) * s >= 0) {
          hedged = true;
          // A pending stop fills at the trigger; if the candle opened already past it (a jump), at that open
          const fill = k === 0 && j > i0 ? px : trig;
          hedge = { price: Math.round(fill * 100) / 100, hours: Math.round(((candles.time[j] - candles.time[i0]) / 3600) * 100) / 100 };
        }
      }
      if (hedged && !story) {
        if ((sl - px) * s >= 0) story = "B";
        else if ((px - tp) * s >= 0) story = "C";
      }
      if (story) {
        const hours = (candles.time[j] + bar - candles.time[i0]) / 3600;
        return { story, hours: Math.round(hours * 100) / 100, mae: Math.round(Math.min(worst, 1) * 1000) / 1000, ...(hedge && { hedge }) };
      }
    }
  }
  return { story: "X", hours: null, mae: Math.round(Math.min(worst, 1) * 1000) / 1000, ...(hedge && { hedge }) };
};

/** Every source (ai / tv / coin) at every setting (t10/t15 x AI's TP / TP = SL). */
export const gradeAll = (candles, i0, dirs, slD, tpD, horizonSec) => {
  const results = {};
  for (const [name, d] of Object.entries(dirs)) {
    if (d !== "buy" && d !== "sell") continue;
    results[name] = {};
    for (const t of TRIGGERS) {
      results[name][`t${Math.round(t * 100)}_tpai`] = walk(candles, i0, d, slD, tpD, t, horizonSec);
      results[name][`t${Math.round(t * 100)}_tp1`] = walk(candles, i0, d, slD, slD, t, horizonSec);
    }
  }
  return results;
};

/** SL/TP distances from a signal's levels, or null when they're on the wrong side. */
export const signalDistances = (sig) => {
  const s = sig.direction === "buy" ? 1 : sig.direction === "sell" ? -1 : 0;
  const entry = Number(sig.entry_price), stop = Number(sig.stop_price), target = Number(sig.target_price);
  if (!s || ![entry, stop, target].every(Number.isFinite)) return null;
  const slD = (entry - stop) * s, tpD = (target - entry) * s;
  return slD > 0 && tpD > 0 ? { slD, tpD } : null;
};
