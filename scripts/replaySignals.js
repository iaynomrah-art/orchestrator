// Historical replay of the AI signal: rebuilds the technical inputs the AI sees
// (1h and daily trend, 200 SMA, RSI, ATR, an approximation of TradingView's
// rating) from MT5 candles at past moments, asks the same model with the same
// prompt, and grades each signal on the 8 hours that followed — for the AI, the
// rating alone and a coin flip, like shadow mode. Trades nothing.
//
// Differences from live signals: no headlines (unrecoverable for past dates), the
// rating is an approximation of TradingView's, and no volatility lines in the prompt.
//
//   node scripts/replaySignals.js --m5 <XAUUSD_M5.csv> --h1 <XAUUSD_H1.csv> [--n 150] [--out replay.jsonl] [--seed 7]
//
// CSV columns: time (broker server epoch), open, high, low, close. Results are
// appended to --out as they come in, and a rerun skips moments already done.
import "dotenv/config";
import fs from "fs";
import { askOllama, scoreSignal } from "../helper/marketHelper.js";
import { summarizeGrades } from "../helper/shadowResultsHelper.js";
import { gradeAll } from "../helper/gradeHelper.js";
import { summarizeCandles, describeCandles, CANDLE_HOURS } from "../helper/candleContext.js";
import { replayRecord, saveReplay } from "./replayStore.js";
import { loadCsv, serverToUtcMs, indicatorsAt, dailyFromHourly, lowerBound } from "./replayData.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const M5_PATH = arg("m5");
const H1_PATH = arg("h1");
const N = Number(arg("n", 150));
const OUT = arg("out", "replay.jsonl");
let seed = Number(arg("seed", 7));
// --candles: add the "last 6 hours of 5-minute candles" lines to the prompt (prompt v2)
const WITH_CANDLES = process.argv.includes("--candles");
// --save: also store each result in replay_signals (the dashboard's "Past data" view)
const SAVE = process.argv.includes("--save");
if (!M5_PATH || !H1_PATH) {
  console.error("Usage: node scripts/replaySignals.js --m5 <M5.csv> --h1 <H1.csv> [--n 150] [--out replay.jsonl]");
  process.exit(1);
}

const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

// ── main ────────────────────────────────────────────────────────────────────
const m5 = loadCsv(M5_PATH);
const h1 = loadCsv(H1_PATH);

const d1 = dailyFromHourly(h1);

// Candidate moments: every 4 hours at :05 broker time, outside rollover (23:00-01:00) and
// with a fresh 5-minute candle; 4 hours apart, so each is an independent call
const candidates = [];
const first = Math.ceil((m5.time[0] + 86400 * 2) / 3600) * 3600;
for (let t = first + 300; t < m5.time[m5.time.length - 1] - 9 * 3600; t += 4 * 3600) {
  const hour = Math.floor(t / 3600) % 24;
  if (hour === 23 || hour === 0) continue;
  const i0 = lowerBound(m5.time, t);
  if (i0 >= m5.time.length || m5.time[i0] - t > 600) continue;   // market closed
  candidates.push({ t, i0 });
}
for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
const picked = candidates.slice(0, N).sort((a, b) => a.t - b.t);

const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l).server_time) : []);
console.log(`Replay: ${picked.length} moments from ${candidates.length} candidates (${done.size} already done) -> ${OUT}`);

const rows = () => fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
const progress = () => {
  const s = summarizeGrades(rows(), "t10_tp1");
  const f = (x) => (x.a_rate == null ? "-" : `${(x.a_rate / 10).toFixed(1)} in 10 (${x.a}/${x.resolved})`);
  console.log(`   no-hedge TP so far [trigger 10%, TP = SL]: AI ${f(s.overall.ai)} | rating ${f(s.overall.tv)} | coin ${f(s.overall.coin)} | luck ${(s.luck_a_rate / 10).toFixed(1)} in 10`);
};

let count = done.size;
let failuresInARow = 0;
for (const { t, i0 } of picked) {
  if (done.has(t)) continue;
  const hi = lowerBound(h1.time, t - 300) - 1;            // last completed hourly candle
  const di = lowerBound(d1.time, Math.floor(t / 86400) * 86400) - 1;   // last completed day
  const micro = indicatorsAt(h1, hi);
  const macro = indicatorsAt(d1, di);
  if (!micro || !macro) continue;
  const utcMs = serverToUtcMs(t);
  let candleLines = [];
  if (WITH_CANDLES) {
    const from = lowerBound(m5.time, t - CANDLE_HOURS * 3600), to = lowerBound(m5.time, t);
    const bars = [];
    for (let k = from; k < to; k++) bars.push({ time: m5.time[k], open: m5.open[k], high: m5.high[k], low: m5.low[k], close: m5.close[k] });
    candleLines = describeCandles(summarizeCandles(bars));
  }
  const ai = await askOllama("XAUUSD", "1 hour", "1 day", micro, macro, [], new Date(utcMs).toUTCString(), [], candleLines);
  if (ai.source !== "ai") {
    // A technicals fallback is the rating, not the AI: never record it as the AI's answer.
    // A busy VPS makes calls time out now and then: wait and retry before giving up.
    if (++failuresInARow >= 10) {
      console.error("Model unavailable 10 times in a row — stopping. Rerun later; finished moments are kept.");
      break;
    }
    console.log(`  model busy or unavailable (${failuresInARow}/10) — waiting 60s, then retrying`);
    await new Promise((r) => setTimeout(r, 60000));
    picked.splice(picked.findIndex((p) => p.t === t) + 1, 0, { t, i0 });   // try this moment again next
    continue;
  }
  failuresInARow = 0;
  const direction = ai.verdict.toLowerCase();
  const { score } = scoreSignal(ai.verdict, micro, macro, ai.news_impact);
  const slD = Math.abs(micro.price - ai.stop_loss), tpD = Math.abs(ai.target_price - micro.price);
  const dirs = { ai: direction, tv: micro.decision.toLowerCase(), coin: rand() < 0.5 ? "buy" : "sell" };
  const row = {
    server_time: t,
    created_at: new Date(utcMs).toISOString(),
    direction, tv_direction: dirs.tv, coin_direction: dirs.coin,
    confidence: score, source: ai.source, news_impact: ai.news_impact, prompt: WITH_CANDLES ? "v2-candles-6h" : "v1", candle_lines: candleLines,
    grade: { sl_distance: slD, tp_distance: tpD, entry_broker: m5.open[i0], results: gradeAll(m5, i0, dirs, slD, tpD, 8 * 3600) },
  };
  fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
  if (SAVE) await saveReplay([replayRecord(row, m5, i0, row.prompt)]).catch((e) => console.error(`  ${e.message}`));
  count++;
  const g = row.grade.results;
  console.log(`[${count}/${picked.length}] ${row.created_at.slice(0, 16)} AI ${direction.padEnd(4)} (rating ${dirs.tv}) score ${score} -> AI ${g.ai.t10_tp1.story}, rating ${g.tv.t10_tp1.story}, coin ${g.coin.t10_tp1.story}`);
  if (count % 10 === 0) progress();
}

console.log("\n=== Final ===");
for (const setting of ["t10_tp1", "t15_tp1", "t10_tpai", "t15_tpai"]) {
  const s = summarizeGrades(rows(), setting);
  console.log(`\n${setting} (luck ${(s.luck_a_rate / 10).toFixed(1)} in 10, ${s.signals} signals)`);
  for (const b of [...s.buckets, { label: "ALL", sources: s.overall }]) {
    const f = (x) => (x.resolved ? `${(x.a_rate / 10).toFixed(1)} in 10 (${x.a}/${x.resolved})` : "-");
    console.log(`  score ${b.label.padEnd(8)}  AI ${f(b.sources.ai).padEnd(18)} rating ${f(b.sources.tv).padEnd(18)} coin ${f(b.sources.coin)}`);
  }
}
const all = rows();
const agree = all.filter((r) => r.direction === r.tv_direction).length;
console.log(`\nAI agreed with the rating on ${agree}/${all.length} signals (${Math.round((agree / Math.max(1, all.length)) * 100)}%).`);
process.exit(0);
