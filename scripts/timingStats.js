// Timing statistics for the dashboard's "Market timing" card, all measured from the
// broker's 5-minute candles (nothing typed in by hand):
//   - average gold move (high - low) per clock hour, per weekday and per month
//   - the live delayed-hedge rule (S/R bounce, x12% budget, 12h levels) replayed with an
//     entry at every hour of the day, held until SL/TP with swaps, one pair at a time,
//     each with a coin-flip luck test
//   - the 9:00 AM PHT rule's trades grouped by weekday and by month
// Writes stats/timing_stats.json, which GET /market/timing serves (the candle files in
// data/ stay local, so the results file is what gets deployed).
//
//   node scripts/timingStats.js --m5 data/XAUUSD.r_M5.csv
import fs from "fs";
import { walk } from "../helper/gradeHelper.js";
import { referenceTrade } from "../helper/shadowResultsHelper.js";
import { srLevels } from "../helper/srLevels.js";
import { loadCsv, serverToUtcMs, lowerBound } from "./replayData.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const M5_PATH = arg("m5");
const OUT = new URL("../stats/timing_stats.json", import.meta.url);
if (!M5_PATH) {
  console.error("Usage: node scripts/timingStats.js --m5 <M5.csv>");
  process.exit(1);
}

// Same settings as the live rule (helper/signalHelper.js) and replay run sr-bounce-40
const LOT = 0.03, SL_DIST = 40, BUDGET = 120, MAX_TRIG_DIST = (20 - 2.4) / (LOT * 100);
const HOLD_SEC = 15 * 86400;
const SWAP = { buy: -130.55, sell: 8.6 };   // $ per lot per night, HeroFX XAUUSD.r
const COIN_RUNS = 300;
const PHT = 8;   // Manila is UTC+8 all year
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const r2 = (v) => Math.round(v * 100) / 100;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const m5 = loadCsv(M5_PATH);
const utcOf = (serverSec) => new Date(serverToUtcMs(serverSec));
const manilaOf = (serverSec) => new Date(serverToUtcMs(serverSec) + PHT * 3600 * 1000);   // read with getUTC*

// ── 1. Average move per clock hour (complete hours only) ────────────────────
const hourMoves = Array.from({ length: 24 }, () => []);
const weekdayMoves = Array.from({ length: 7 }, () => []);
const monthMoves = new Map();
for (let j = 0; j < m5.time.length;) {
  const start = Math.floor(m5.time[j] / 3600) * 3600;
  let hi = -Infinity, lo = Infinity, k = j;
  while (k < m5.time.length && m5.time[k] < start + 3600) { hi = Math.max(hi, m5.high[k]); lo = Math.min(lo, m5.low[k]); k++; }
  if (k - j >= 10) {
    const manila = manilaOf(start);
    hourMoves[manila.getUTCHours()].push(hi - lo);
    weekdayMoves[manila.getUTCDay()].push(hi - lo);
    const key = utcOf(start).toISOString().slice(0, 7);
    if (!monthMoves.has(key)) monthMoves.set(key, []);
    monthMoves.get(key).push(hi - lo);
  }
  j = k;
}

// ── 2. The live rule with an entry at every hour ────────────────────────────
const nights = (from, to) => {
  let n = 0;
  for (let day = Math.floor(from / 86400) + 1; day * 86400 <= to; day++) {
    const weekday = new Date(day * 86400 * 1000).getUTCDay();
    n += weekday === 4 ? 3 : weekday === 0 || weekday === 1 ? 0 : 1;
  }
  return n;
};
const priceAt = (t) => m5.close[Math.max(0, lowerBound(m5.time, t) - 1)];

/** One side at one moment, held until SL/TP: { pnl, clean, closeAt } (pnl as the dashboard prices it). */
const tradeSide = (i0, dir, lvl) => {
  const entry = m5.open[i0], t0 = m5.time[i0];
  const raw = dir === "buy" ? lvl.support - 0.5 : lvl.resistance + 0.5;
  const trigger = Math.max(2.5, Math.min(Math.abs(entry - raw), MAX_TRIG_DIST)) / SL_DIST;
  const tpDistance = Math.max(lvl.range, 5);
  const w = walk(m5, i0, dir, SL_DIST, tpDistance, trigger, HOLD_SEC, { carryWeekend: true });
  const closeAt = w.hours != null ? t0 + w.hours * 3600 : t0 + HOLD_SEC;
  const opp = dir === "buy" ? "sell" : "buy";
  const swap = {
    primary: nights(t0, closeAt) * SWAP[dir] * LOT,
    hedge: w.hedge ? nights(t0 + w.hedge.hours * 3600, closeAt) * SWAP[opp] * LOT : 0,
  };
  const t = referenceTrade(dir, entry, SL_DIST, w.story, {
    hedge: w.hedge ?? null, mae: w.mae, markPrice: priceAt(t0 + HOLD_SEC), trigger, tpDistance, lot: LOT, swap,
  });
  return { pnl: t?.pnl ?? 0, clean: w.story === "A", closeAt };
};

const ruleAtHour = (manilaHour) => {
  const trades = [];
  let busyUntil = 0;
  for (let t = Math.ceil((m5.time[0] + 2 * 86400) / 3600) * 3600 + 300; t < m5.time[m5.time.length - 1] - 9 * 3600; t += 3600) {
    const manila = manilaOf(t);
    if (manila.getUTCHours() !== manilaHour) continue;
    const i0 = lowerBound(m5.time, t);
    if (i0 >= m5.time.length || m5.time[i0] - t > 600) continue;   // market closed
    const lvl = srLevels(Array.from({ length: i0 - lowerBound(m5.time, t - 12 * 3600) }, (_, n) => {
      const j = lowerBound(m5.time, t - 12 * 3600) + n;
      return { time: m5.time[j], high: m5.high[j], low: m5.low[j], close: m5.close[j] };
    }), m5.time[i0]);
    if (!lvl || !(lvl.range > 0)) continue;
    const pos = (m5.open[i0] - lvl.support) / lvl.range;
    if (!(pos <= 0.25 || pos >= 0.75) || lvl.range * LOT * 100 >= BUDGET) continue;
    if (m5.time[i0] < busyUntil) continue;   // one pair: the last one is still open
    const dir = pos <= 0.5 ? "buy" : "sell";
    const mine = tradeSide(i0, dir, lvl);
    const other = tradeSide(i0, dir === "buy" ? "sell" : "buy", lvl);
    busyUntil = mine.closeAt;
    trades.push({ manila, mine, other });
  }
  const pnl = trades.reduce((s, x) => s + x.mine.pnl, 0);
  // Luck: coin flips picking either side at the same moments
  let seed = 1000 + manilaHour;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  let below = 0;
  for (let k = 0; k < COIN_RUNS; k++) {
    const coin = trades.reduce((s, x) => s + (rand() < 0.5 ? x.mine.pnl : x.other.pnl), 0);
    if (coin < pnl) below++;
  }
  return {
    trades: trades.length, clean: trades.filter((x) => x.mine.clean).length, pnl: r2(pnl),
    beats_pct: trades.length ? Math.round((below / COIN_RUNS) * 100) : null, list: trades,
  };
};

const hourly = Array.from({ length: 24 }, (_, h) => {
  const rule = ruleAtHour(h);
  return {
    pht_hour: h, utc_hour: (h - PHT + 24) % 24,
    avg_move: r2(avg(hourMoves[h])), samples: hourMoves[h].length,
    bounce: { trades: rule.trades, clean: rule.clean, pnl: rule.pnl, beats_pct: rule.beats_pct },
    _list: rule.list,
  };
});

// ── 3. The 9:00 AM PHT rule's trades by weekday and by month ────────────────
const nine = hourly[9]._list;
const group = (keyOf) => {
  const m = new Map();
  for (const x of nine) {
    const k = keyOf(x);
    const g = m.get(k) ?? { trades: 0, clean: 0, pnl: 0 };
    g.trades++; g.clean += x.mine.clean ? 1 : 0; g.pnl += x.mine.pnl;
    m.set(k, g);
  }
  return m;
};
const nineByWeekday = group((x) => x.manila.getUTCDay());
const nineByMonth = group((x) => x.manila.toISOString().slice(0, 7));

const weekday = [1, 2, 3, 4, 5].map((d) => {
  const g = nineByWeekday.get(d) ?? { trades: 0, clean: 0, pnl: 0 };
  return { day: WEEKDAYS[d], avg_move: r2(avg(weekdayMoves[d])), samples: weekdayMoves[d].length, nine_am: { ...g, pnl: r2(g.pnl) } };
});
const monthly = [...monthMoves.keys()].sort().map((key) => {
  const g = nineByMonth.get(key) ?? { trades: 0, clean: 0, pnl: 0 };
  return { month: key, avg_move: r2(avg(monthMoves.get(key))), samples: monthMoves.get(key).length, nine_am: { ...g, pnl: r2(g.pnl) } };
});

const out = {
  generated_at: new Date().toISOString(),
  source: {
    file: M5_PATH.split(/[\\/]/).pop(),
    from: utcOf(m5.time[0]).toISOString(), to: utcOf(m5.time[m5.time.length - 1]).toISOString(),
    candles: m5.time.length, hours: hourMoves.reduce((s, a) => s + a.length, 0),
  },
  rule: { name: "S/R bounce, x12% budget ($40 stop), 12h levels, 25% zone", lot: LOT, sl_distance: SL_DIST, live_pht_hour: 9, coin_runs: COIN_RUNS },
  hourly: hourly.map(({ _list, ...h }) => h),
  weekday,
  monthly,
};
fs.mkdirSync(new URL("../stats/", import.meta.url), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT.pathname}: ${out.source.hours} hours of candles, ${out.source.from.slice(0, 10)} to ${out.source.to.slice(0, 10)}`);
for (const h of out.hourly) console.log(`${String(h.pht_hour).padStart(2, "0")}:00 PHT  move $${h.avg_move}  rule: ${h.bounce.trades} trades, ${h.bounce.clean} clean, $${h.bounce.pnl}, beats ${h.bounce.beats_pct}%`);
