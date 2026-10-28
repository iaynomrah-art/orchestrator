// Past-data test of trade setups (no AI call), saved as runs in replay_signals so
// the dashboard can compare them with the AI runs:
//   rating-tNN   the TradingView-style rating picks the side (the AI copied it every
//                time), with the backup opening at an NN% dip instead of 10%
//   perfect-tNN  a forecaster that knows where the price will be 8 hours later: the
//                ceiling for any AI or prompt at that setting
// Same moments as the AI replay (every 4 hours at :05 broker time, outside rollover)
// and the same stop as the AI's signals (1.5 x the 1-hour ATR), TP = stop.
// --every 1 uses every hour instead, like live shadow mode (runs get a "-hourly" suffix).
//
//   node scripts/replaySetups.js --m5 <M5.csv> --h1 <H1.csv> [--triggers 0.1,0.15,0.2] [--pickers rating,perfect] [--every 4] [--save]
import "dotenv/config";
import { walk } from "../helper/gradeHelper.js";
import { scoreboard } from "../helper/shadowResultsHelper.js";
import { replayRecord, saveReplay } from "./replayStore.js";
import { loadCsv, serverToUtcMs, indicatorsAt, lowerBound } from "./replayData.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const M5_PATH = arg("m5"), H1_PATH = arg("h1");
const TRIGGERS = arg("triggers", "0.1,0.15,0.2").split(",").map(Number);
const PICKERS = arg("pickers", "rating,perfect").split(",");
const EVERY_HOURS = Number(arg("every", 4));
const SESSION = arg("session", "all");   // all | london-ny | asia
const SAVE = process.argv.includes("--save");
if (!M5_PATH || !H1_PATH) {
  console.error("Usage: node scripts/replaySetups.js --m5 <M5.csv> --h1 <H1.csv> [--triggers 0.1,0.15,0.2] [--pickers rating,perfect] [--session all|london-ny|asia] [--save]");
  process.exit(1);
}

const HORIZON_SEC = 8 * 3600;
const STOP_ATR = 1.5;   // the AI signal's stop: 1.5 x ATR from the entry
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const m5 = loadCsv(M5_PATH);
const h1 = loadCsv(H1_PATH);

/** Close of the last 5-minute candle before the 8-hour mark. */
const priceAt8h = (i0) => {
  const j = lowerBound(m5.time, m5.time[i0] + HORIZON_SEC);
  return m5.close[Math.max(i0, Math.min(j, m5.time.length) - 1)];
};

const moments = [];
const first = Math.ceil((m5.time[0] + 86400 * 2) / 3600) * 3600;
for (let t = first + 300; t < m5.time[m5.time.length - 1] - 9 * 3600; t += EVERY_HOURS * 3600) {
  const hour = Math.floor(t / 3600) % 24;
  if (hour === 23 || hour === 0) continue;   // broker rollover
  const i0 = lowerBound(m5.time, t);
  if (i0 >= m5.time.length || m5.time[i0] - t > 600) continue;   // market closed
  const micro = indicatorsAt(h1, lowerBound(h1.time, t - 300) - 1);
  if (!micro || !(micro.atr > 0)) continue;

  const utcMs = serverToUtcMs(t);
  const utcHour = new Date(utcMs).getUTCHours();
  if (SESSION === "london-ny" && (utcHour < 7 || utcHour > 17)) continue;
  if (SESSION === "asia" && (utcHour >= 7 && utcHour <= 17)) continue;

  moments.push({
    t, i0, slD: STOP_ATR * micro.atr,
    utcHour,
    rating: micro.decision.toLowerCase(),
    perfect: priceAt8h(i0) >= m5.open[i0] ? "buy" : "sell",
    coin: rand() < 0.5 ? "buy" : "sell",
  });
}
console.log(`${moments.length} moments (session: ${SESSION}), every ${EVERY_HOURS} hours; stop = ${STOP_ATR} x ATR(1h), TP = stop`);

for (const picker of PICKERS) {
  for (const trigger of TRIGGERS) {
    const sessionSuffix = SESSION === "all" ? "" : `-${SESSION}`;
    const run = `${picker}-t${Math.round(trigger * 100)}${sessionSuffix}${EVERY_HOURS === 4 ? "" : EVERY_HOURS === 1 ? "-hourly" : `-every${EVERY_HOURS}h`}`;
    const records = moments.map((m) => {
      const direction = m[picker];
      const row = {
        created_at: new Date(serverToUtcMs(m.t)).toISOString(),
        direction, tv_direction: m.rating, coin_direction: m.coin, confidence: null,
        grade: { sl_distance: m.slD, tp_distance: m.slD },
      };
      const rec = replayRecord(row, m5, m.i0, run);
      // "main": this run's own setting (its trigger, TP = SL), read by the dashboard
      for (const [src, d] of [["ai", direction], ["tv", m.rating], ["coin", m.coin]]) {
        rec.grade.results[src].main = walk(m5, m.i0, d, m.slD, m.slD, trigger, HORIZON_SEC);
      }
      rec.grade.trigger = trigger;
      rec.inputs = { picker, trigger, session: SESSION, rule: { name: picker === "perfect" ? "perfect-8h" : "rating-trigger", trigger, session: SESSION, stop: `${STOP_ATR} x ATR(1h)` } };
      return rec;
    });
    const b = scoreboard(records.map((r) => ({ ...r, trigger })), "main");
    const f = (x) => `${((x.a / x.graded) * 10).toFixed(2)} in 10 of all (${x.a}/${x.graded}), ${x.x} unfinished, ${x.pnl >= 0 ? "+" : ""}$${x.pnl}`;
    console.log(`${run.padEnd(12)} picker ${f(b.ai)} | coin ${f(b.coin)}`);
    if (SAVE) {
      await saveReplay(records);
      console.log(`  saved ${records.length} rows as run "${run}"`);
    }
  }
}
if (!SAVE) console.log("\nDry run. Add --save to store the runs for the dashboard.");
