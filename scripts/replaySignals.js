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

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const M5_PATH = arg("m5");
const H1_PATH = arg("h1");
const N = Number(arg("n", 150));
const OUT = arg("out", "replay.jsonl");
let seed = Number(arg("seed", 7));
if (!M5_PATH || !H1_PATH) {
  console.error("Usage: node scripts/replaySignals.js --m5 <M5.csv> --h1 <H1.csv> [--n 150] [--out replay.jsonl]");
  process.exit(1);
}

const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const loadCsv = (path) => {
  const [header, ...lines] = fs.readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = header.split(",");
  const idx = (c) => cols.indexOf(c);
  const out = { time: [], open: [], high: [], low: [], close: [] };
  for (const line of lines) {
    const v = line.split(",");
    for (const k of Object.keys(out)) out[k].push(Number(v[idx(k)]));
  }
  return out;
};

// ── broker clock (New York + 7h, the usual MT5 server time) ─────────────────
const nyOffset = (utcMs) => {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month, 1));
    return 1 + ((7 - first.getUTCDay()) % 7) + 7 * (n - 1);
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7);
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6);
  return utcMs >= start && utcMs < end ? -4 : -5;
};
const serverToUtcMs = (serverSec) => {
  const guess = serverSec * 1000 - 3 * 3600 * 1000;
  return serverSec * 1000 - (nyOffset(guess) + 7) * 3600 * 1000;
};

// ── indicators (TradingView definitions where public) ───────────────────────
const sma = (a, p, i) => (i + 1 < p ? NaN : a.slice(i + 1 - p, i + 1).reduce((s, x) => s + x, 0) / p);
const emaSeries = (a, p) => {
  const k = 2 / (p + 1);
  const out = [];
  a.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
  return out;
};
const wilder = (a, p) => {
  const out = [];
  a.forEach((x, i) => out.push(i === 0 ? x : (out[i - 1] * (p - 1) + x) / p));
  return out;
};

const indicatorsAt = (bars, i) => {
  // The last 600 candles are plenty for a 200-period average and the EMA/Wilder warm-up
  const from = Math.max(0, i + 1 - 600);
  const c = bars.close.slice(from, i + 1), h = bars.high.slice(from, i + 1), l = bars.low.slice(from, i + 1);
  const n = c.length;
  if (n < 210) return null;
  const tr = c.map((x, j) => (j === 0 ? h[j] - l[j] : Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1]))));
  const atr = wilder(tr, 14)[n - 1];
  const gains = c.map((x, j) => (j === 0 ? 0 : Math.max(0, x - c[j - 1])));
  const losses = c.map((x, j) => (j === 0 ? 0 : Math.max(0, c[j - 1] - x)));
  const ag = wilder(gains, 14), al = wilder(losses, 14);
  const rsiAt = (j) => (al[j] === 0 ? 100 : 100 - 100 / (1 + ag[j] / al[j]));
  const rsi = rsiAt(n - 1), rsiPrev = rsiAt(n - 2);
  const ema26 = emaSeries(c, 26);
  const macdLine = emaSeries(c, 12).map((x, j) => x - ema26[j]);
  const macdSignal = emaSeries(macdLine, 9);
  const price = c[n - 1];

  // Rating ~ TradingView's: average of moving-average votes and oscillator votes
  const maVotes = [];
  for (const p of [10, 20, 30, 50, 100, 200]) {
    const s = sma(c, p, n - 1), e = emaSeries(c, p)[n - 1];
    maVotes.push(Math.sign(price - s), Math.sign(price - e));
  }
  const hh = Math.max(...h.slice(-14)), ll = Math.min(...l.slice(-14));
  const k = hh === ll ? 50 : ((price - ll) / (hh - ll)) * 100;
  const wr = k - 100;
  const wrPrev = (() => {
    const h2 = Math.max(...h.slice(-15, -1)), l2 = Math.min(...l.slice(-15, -1));
    return h2 === l2 ? -50 : ((c[n - 2] - l2) / (h2 - l2)) * 100 - 100;
  })();
  const tp = c.map((x, j) => (h[j] + l[j] + x) / 3);
  const cciAt = (j) => {
    const win = tp.slice(j - 19, j + 1);
    const m = win.reduce((s, x) => s + x, 0) / 20;
    const md = win.reduce((s, x) => s + Math.abs(x - m), 0) / 20;
    return md === 0 ? 0 : (tp[j] - m) / (0.015 * md);
  };
  const cci = cciAt(n - 1), cciPrev = cciAt(n - 2);
  const mom = price - c[n - 11], momPrev = c[n - 2] - c[n - 12];
  const oscVotes = [
    rsi < 30 && rsi > rsiPrev ? 1 : rsi > 70 && rsi < rsiPrev ? -1 : 0,
    k < 20 ? 1 : k > 80 ? -1 : 0,
    cci < -100 && cci > cciPrev ? 1 : cci > 100 && cci < cciPrev ? -1 : 0,
    Math.sign(mom - momPrev),
    Math.sign(macdLine[n - 1] - macdSignal[n - 1]),
    wr < -80 && wr > wrPrev ? 1 : wr > -20 && wr < wrPrev ? -1 : 0,
  ];
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const recommendAll = (avg(maVotes) + avg(oscVotes)) / 2;
  const decision = recommendAll >= 0 ? "BUY" : "SELL";
  const buyVotes = [...maVotes, ...oscVotes].filter((v) => v > 0).length;
  const sellVotes = [...maVotes, ...oscVotes].filter((v) => v < 0).length;
  return {
    decision,
    process: `Analyzed 18 indicators (replay approximation). Results: ${buyVotes} BUY, ${sellVotes} SELL. Verdict: ${decision}.`,
    price: Math.round(price * 100) / 100,
    raw_rsi: Math.round(rsi * 100) / 100,
    recommend_all: recommendAll,
    atr: Math.round(atr * 100) / 100,
    sma_200: Math.round(sma(c, 200, n - 1) * 100) / 100,
  };
};

// ── main ────────────────────────────────────────────────────────────────────
const m5 = loadCsv(M5_PATH);
const h1 = loadCsv(H1_PATH);

// Daily candles from the hourly ones (broker day = New York 17:00, like TradingView's gold daily)
const d1 = { time: [], open: [], high: [], low: [], close: [] };
h1.time.forEach((t, i) => {
  const day = Math.floor(t / 86400);
  const last = d1.time.length - 1;
  if (last < 0 || Math.floor(d1.time[last] / 86400) !== day) {
    d1.time.push(day * 86400); d1.open.push(h1.open[i]); d1.high.push(h1.high[i]); d1.low.push(h1.low[i]); d1.close.push(h1.close[i]);
  } else {
    d1.high[last] = Math.max(d1.high[last], h1.high[i]); d1.low[last] = Math.min(d1.low[last], h1.low[i]); d1.close[last] = h1.close[i];
  }
});

// Candidate moments: every 4 hours at :05 broker time, outside rollover (23:00-01:00) and
// with a fresh 5-minute candle; 4 hours apart, so each is an independent call
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
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
  const ai = await askOllama("XAUUSD", "1 hour", "1 day", micro, macro, [], new Date(utcMs).toUTCString(), []);
  if (ai.source !== "ai") {
    // A technicals fallback is the rating, not the AI: never record it as the AI's answer
    if (++failuresInARow >= 3) {
      console.error("Model unavailable 3 times in a row — stopping. Rerun later; finished moments are kept.");
      break;
    }
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
    confidence: score, source: ai.source, news_impact: ai.news_impact,
    grade: { sl_distance: slD, tp_distance: tpD, entry_broker: m5.open[i0], results: gradeAll(m5, i0, dirs, slD, tpD, 8 * 3600) },
  };
  fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
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
