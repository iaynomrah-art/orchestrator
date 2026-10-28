// Past-data test: S/R proximity direction picker.
//
// The idea: forget the AI, forget the TradingView rating. Instead, look at where
// the current price sits relative to support and resistance:
//   - Price in the bottom X% of the range → BUY  (expect bounce off support)
//   - Price in the top X% of the range    → SELL (expect rejection at resistance)
//   - Price in the middle                 → SKIP (no edge)
//
// Support = lowest low of the last N hours of 5-minute candles
// Resistance = highest high of the last N hours of 5-minute candles
//
// This tests whether the S/R levels themselves can pick a better direction than
// the AI or a coin flip, using the same delayed-hedge mechanics.
//
//   node scripts/replaySR.js --m5 <M5.csv> --h1 <H1.csv> [--zones 25,33,40] [--windows 6,12] [--triggers 0.10,0.15] [--save]
import "dotenv/config";
import { walk } from "../helper/gradeHelper.js";
import { scoreboard, dailyBreakdown } from "../helper/shadowResultsHelper.js";
import { replayRecord, saveReplay } from "./replayStore.js";
import { loadCsv, serverToUtcMs, indicatorsAt, lowerBound } from "./replayData.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const M5_PATH = arg("m5"), H1_PATH = arg("h1");
// Zone = how close to support/resistance to trigger (as % of the range)
// 25% = price must be in the bottom or top quarter of the range
const ZONES = arg("zones", "20,25,33,40").split(",").map(Number);
// S/R lookback windows in hours
const WINDOWS = arg("windows", "6,12").split(",").map(Number);
const TRIGGERS = arg("triggers", "0.10,0.15").split(",").map(Number);
const SAVE = process.argv.includes("--save");
if (!M5_PATH || !H1_PATH) {
  console.error("Usage: node scripts/replaySR.js --m5 <M5.csv> --h1 <H1.csv> [--zones 25,33,40] [--windows 6,12] [--triggers 0.10,0.15] [--save]");
  process.exit(1);
}

const HORIZON_SEC = 8 * 3600;
const STOP_ATR = 1.5;
const PUMP_MULTIPLE = 6;
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const m5 = loadCsv(M5_PATH);
const h1 = loadCsv(H1_PATH);

/**
 * Support (lowest low) and resistance (highest high) from the 5-minute candles
 * in the last `hours` before candle i0. Uses highs and lows, not just closes.
 */
const levelsAt = (i0, hours) => {
  const t = m5.time[i0];
  const from = lowerBound(m5.time, t - hours * 3600);
  if (i0 - from < Math.floor(hours * 10)) return null; // not enough data (market was closed)
  // Pump/dump detection: if any 1-hour block moved 6x the median, shrink to 6h
  const closes = m5.close.slice(from, i0);
  const moves = [];
  for (let k = 12; k < closes.length; k++) moves.push(Math.abs(closes[k] - closes[k - 12]));
  const median = [...moves].sort((a, b) => a - b)[Math.floor(moves.length / 2)];
  const pump = moves.length > 0 && Math.max(...moves) >= PUMP_MULTIPLE * median;
  const actualFrom = pump ? lowerBound(m5.time, t - 6 * 3600) : from;
  const highs = m5.high.slice(actualFrom, i0);
  const lows = m5.low.slice(actualFrom, i0);
  const support = Math.min(...lows), resistance = Math.max(...highs);
  return { support, resistance, range: resistance - support, pump, window: pump ? 6 : hours };
};

/**
 * Where price sits in the S/R range: 0 = at support, 1 = at resistance.
 * Returns null if the range is too tight (< $2).
 */
const positionInRange = (price, levels) => {
  if (!levels || levels.range < 2) return null;
  return (price - levels.support) / levels.range;
};

// Build all moments (every hour, like live)
const rawMoments = [];
for (let t = Math.ceil((m5.time[0] + 2 * 86400) / 3600) * 3600 + 300; t < m5.time[m5.time.length - 1] - 9 * 3600; t += 3600) {
  const hour = Math.floor(t / 3600) % 24;
  if (hour === 23 || hour === 0) continue;
  const i0 = lowerBound(m5.time, t);
  if (i0 >= m5.time.length || m5.time[i0] - t > 600) continue;
  const micro = indicatorsAt(h1, lowerBound(h1.time, t - 300) - 1);
  if (!micro || !(micro.atr > 0)) continue;
  rawMoments.push({
    t, i0, slD: STOP_ATR * micro.atr,
    price: m5.open[i0],
    rating: micro.decision.toLowerCase(),
    coin: rand() < 0.5 ? "buy" : "sell",
  });
}
console.log(`${rawMoments.length} hourly moments loaded\n`);

// Test each combination
for (const windowH of WINDOWS) {
  for (const zonePct of ZONES) {
    const zone = zonePct / 100;
    for (const trigger of TRIGGERS) {
      const run = `sr-proximity-${windowH}h-z${zonePct}-t${Math.round(trigger * 100)}`;
      let taken = 0, skipped = 0;
      const records = [];

      for (const m of rawMoments) {
        const levels = levelsAt(m.i0, windowH);
        const pos = positionInRange(m.price, levels);

        // Determine direction from S/R proximity
        let direction = null;
        if (pos !== null) {
          if (pos <= zone) direction = "buy";       // near support → BUY
          else if (pos >= 1 - zone) direction = "sell";  // near resistance → SELL
        }
        const passed = direction !== null;

        const dir = direction || m.rating; // fallback for grading skipped moments
        const row = {
          created_at: new Date(serverToUtcMs(m.t)).toISOString(),
          direction: dir, tv_direction: m.rating, coin_direction: m.coin, confidence: null,
          trigger,
          grade: { sl_distance: m.slD, tp_distance: m.slD },
        };
        const rec = replayRecord(row, m5, m.i0, run);
        for (const [src, d] of [["ai", dir], ["tv", m.rating], ["coin", m.coin]]) {
          rec.grade.results[src].main = walk(m5, m.i0, d, m.slD, m.slD, trigger, HORIZON_SEC);
        }
        rec.grade.trigger = trigger;
        const r2 = (v) => Math.round(v * 100) / 100;
        rec.inputs = {
          picker: "sr-proximity",
          trigger,
          rule: {
            name: "sr-proximity", passed, zone: zonePct, window_hours: windowH,
            support: levels ? r2(levels.support) : null,
            resistance: levels ? r2(levels.resistance) : null,
            range: levels ? r2(levels.range) : null,
            position: pos !== null ? Math.round(pos * 1000) / 1000 : null,
            pump_dump: levels?.pump ?? false,
            stop: `${STOP_ATR} x ATR(1h)`,
          },
        };
        records.push(rec);
        if (passed) taken++; else skipped++;
      }

      // Score only the trades that passed the filter
      const takenRecords = records.filter((r) => r.inputs.rule.passed);
      const skippedRecords = records.filter((r) => !r.inputs.rule.passed);
      const board = scoreboard(takenRecords.map((r) => ({ ...r, trigger })), "main");
      const daily = dailyBreakdown(takenRecords.map((r) => ({ ...r, trigger })), "main");
      const t = board.ai;
      const coinT = board.coin;

      const cleanRate = t.graded ? ((t.a / t.graded) * 100).toFixed(1) : "—";
      const coinRate = coinT.graded ? ((coinT.a / coinT.graded) * 100).toFixed(1) : "—";
      const perTrade = t.graded ? (t.pnl / t.graded).toFixed(2) : "—";
      const s = daily.one_at_a_time.summary;

      console.log(`${run}:`);
      console.log(`  Taken: ${taken} trades (skipped ${skipped})`);
      console.log(`  S/R picker:  Clean TP ${t.a}/${t.graded} (${cleanRate}%) | Unfinished: ${t.x} | Per trade: $${perTrade} | PnL/Day: $${s.pnl_per_day} | Total: $${t.pnl}`);
      console.log(`  Coin flip:   Clean TP ${coinT.a}/${coinT.graded} (${coinRate}%) | Total: $${coinT.pnl}`);
      if (s.days > 0) {
        console.log(`  Daily: ${s.a_per_day} TPs/day | ${s.days - s.days_by_tp['0']}/${s.days} days with >=1 TP (${((1 - s.days_by_tp['0'] / s.days) * 100).toFixed(0)}%)`);
      }

      // Also show what the skipped moments would have done
      if (skippedRecords.length) {
        const sb = scoreboard(skippedRecords.map((r) => ({ ...r, trigger })), "main");
        const st = sb.ai;
        console.log(`  Skipped would have been: ${st.a}/${st.graded} clean TPs, $${st.pnl}`);
      }
      console.log();

      if (SAVE) {
        await saveReplay(records);
        console.log(`  saved ${records.length} rows as run "${run}"\n`);
      }
    }
  }
}
if (!SAVE) console.log("Dry run. Add --save to store the runs for the dashboard.");
