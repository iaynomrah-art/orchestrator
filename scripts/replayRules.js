// Past-data test of rule-based approaches (no AI call), saved as runs in
// replay_signals so the dashboard can compare them with the AI runs.
//
// One moment a day, 9:00 AM Philippine time (01:05 UTC). Support/resistance = the
// lowest low and highest high of the last 12 hours, or of the last 6 hours after a
// pump or dump. Every rule trades a fixed lot with a stop of target x f, TP = the S/R
// range (at least $5), and a delayed hedge $0.50 past the S/R level on the losing side,
// capped at a $20 loss.
//
// Graded like a real account:
//   - each trade is held until its SL or TP (up to --hold-days), over weekends too;
//     a jump past the hedge trigger fills the hedge at the jump price
//   - every open leg pays the broker's overnight swap (Wednesday counts 3 nights)
//   - one pair of accounts: a day's signal is skipped while the last pair is still open
// Moments a rule skips are saved too (inputs.rule.passed = false; rule.busy when only
// because the pair was still open), so the dashboard can show how they would have done.
// Every moment is also graded on the opposite side (grade.results.opp) for the luck test.
//
//   node scripts/replayRules.js --m5 <M5.csv> --h1 <H1.csv> [--target 1000] [--lot 0.03] [--f 0.08,0.12,0.15]
//        [--hold-days 15] [--swap-long -130.55] [--swap-short 8.6] [--save]
import "dotenv/config";
import { walk } from "../helper/gradeHelper.js";
import { scoreboard, luckTest } from "../helper/shadowResultsHelper.js";
import { replayRecord, saveReplay } from "./replayStore.js";
import { srLevels } from "../helper/srLevels.js";
import { loadCsv, serverToUtcMs, indicatorsAt, lowerBound } from "./replayData.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const M5_PATH = arg("m5"), H1_PATH = arg("h1");
const TARGET = Number(arg("target", 1000));
const LOT = Number(arg("lot", 0.03));
const FS = arg("f", "0.08,0.12,0.15").split(",").map(Number);
const HOLD_DAYS = Number(arg("hold-days", 15));
// Overnight swap, $ per 1.0 lot per night: HeroFX XAUUSD.r (MT5 symbol info, Oct 2026)
const SWAP = { buy: Number(arg("swap-long", -130.55)), sell: Number(arg("swap-short", 8.6)) };
const SAVE = process.argv.includes("--save");
if (!M5_PATH || !H1_PATH) {
  console.error("Usage: node scripts/replayRules.js --m5 <M5.csv> --h1 <H1.csv> [--target 1000] [--lot 0.03] [--f 0.08,0.12,0.15] [--hold-days 15] [--swap-long -130.55] [--swap-short 8.6] [--save]");
  process.exit(1);
}

const HOLD_SEC = HOLD_DAYS * 86400;
// Maximum loss of a hedged pair: $20 including the broker fees of both accounts (about $80
// per lot: $2.40 at 0.03 lot, so $5.87 of price; $1.60 at 0.02 lot, so $9.20 of price)
const MAX_LOSS_DOLLARS = 20;
const maxTrigDist = (lot, maxLoss = MAX_LOSS_DOLLARS) => (maxLoss - 80 * lot) / (lot * 100);
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const r2 = (v) => Math.round(v * 100) / 100;

const m5 = loadCsv(M5_PATH);
const h1 = loadCsv(H1_PATH);

/** Support/resistance before candle i0 (same helper as the live signal), or null without 10h of candles. */
const levelsAt = (i0) => {
  const t = m5.time[i0];
  const bars = [];
  for (let j = lowerBound(m5.time, t - 12 * 3600); j < i0; j++) bars.push({ time: m5.time[j], high: m5.high[j], low: m5.low[j], close: m5.close[j] });
  return srLevels(bars, t);
};

/** Plain lowest low / highest high of the last 2 hours (at 9am PHT: the early Asian session). */
const levels2At = (i0) => {
  const t = m5.time[i0];
  const from2 = lowerBound(m5.time, t - 2 * 3600);
  if (i0 - from2 < 14) return null;
  const support = Math.min(...m5.low.slice(from2, i0)), resistance = Math.max(...m5.high.slice(from2, i0));
  return { pump: false, hours: 2, support, resistance, range: resistance - support };
};

/** Local 6-hour Asian session S/R levels (tighter, avoids distant New York lows). */
const levels6At = (i0) => {
  const t = m5.time[i0];
  const from6 = lowerBound(m5.time, t - 6 * 3600);
  if (i0 - from6 < 36) return null;
  const highs = m5.high.slice(from6, i0);
  const lows = m5.low.slice(from6, i0);
  const support = Math.min(...lows), resistance = Math.max(...highs);
  return { pump: false, hours: 6, support, resistance, range: resistance - support };
};

/** 30-Day macro trend from 1h candles: determines macro direction bias (BULLISH vs BEARISH). */
const macro30dAt = (t) => {
  const i = lowerBound(h1.time, t);
  const i30d = lowerBound(h1.time, t - 30 * 86400);
  if (i - i30d < 400) return null;
  const windowCloses = h1.close.slice(i30d, i);
  const sma30d = windowCloses.reduce((a, b) => a + b, 0) / windowCloses.length;
  const closeNow = h1.close[i - 1];
  return { isBullish: closeNow >= sma30d, sma30d, net30d: closeNow - h1.close[i30d] };
};

// US data releases, seen in the candles: the 5-minute bar at 8:30 or 10:00 New York
// (15:30 / 17:00 server time, which runs on New York + 7) moving 4x+ a normal bar of the
// 6 hours before. Marks the trades a release hit while they were open (rule.us_news).
const newsSpikes = [];
for (let j = 72; j < m5.time.length; j++) {
  const sod = m5.time[j] % 86400;
  if (sod !== 15.5 * 3600 && sod !== 17 * 3600) continue;
  const prev = [];
  for (let k = j - 72; k < j; k++) prev.push(m5.high[k] - m5.low[k]);
  prev.sort((a, b) => a - b);
  if (m5.high[j] - m5.low[j] >= 4 * prev[36]) newsSpikes.push(m5.time[j]);
}
const newsBetween = (from, to) => newsSpikes.filter((t) => t >= from && t <= to);

/** Direction of each calendar month (UTC), first open to last close: hindsight, for an upper bound only. */
const monthDirection = new Map();
for (let j = 0; j < m5.time.length; j++) {
  const key = new Date(serverToUtcMs(m5.time[j])).toISOString().slice(0, 7);
  const mo = monthDirection.get(key) ?? { open: m5.open[j], close: m5.close[j] };
  mo.close = m5.close[j];
  monthDirection.set(key, mo);
}
for (const [key, mo] of monthDirection) monthDirection.set(key, mo.close >= mo.open ? "buy" : "sell");

/** One moment a day at a UTC hour and minute, with its levels and indicators. */
const momentsAt = (utcHour, minute = 5) => {
const moments = [];
for (let t = Math.ceil((m5.time[0] + 2 * 86400) / 3600) * 3600 + minute * 60; t < m5.time[m5.time.length - 1] - 9 * 3600; t += 3600) {
  if (new Date(serverToUtcMs(t)).getUTCHours() !== utcHour) continue;
  const hour = Math.floor(t / 3600) % 24;
  if (hour === 23 || hour === 0) continue;   // broker rollover
  const i0 = lowerBound(m5.time, t);
  if (i0 >= m5.time.length || m5.time[i0] - t > 600) continue;   // market closed
  const levels = levelsAt(i0);
  const micro = indicatorsAt(h1, lowerBound(h1.time, t - 300) - 1);
  if (!levels || !micro) continue;
  moments.push({ t, i0, levels, levels6: levels6At(i0) || levels, levels2: levels2At(i0) || levels,
    month: monthDirection.get(new Date(serverToUtcMs(t)).toISOString().slice(0, 7)), macro30d: macro30dAt(t), micro, rating: micro.decision.toLowerCase(), coin: rand() < 0.5 ? "buy" : "sell" });
}
return moments;
};
// 9:00 AM PHT (01:00 UTC) for every rule; 8:00 PM PHT (12:00 UTC) added for the rules that ask for it
const moments = momentsAt(1);
const moments8pm = momentsAt(12);
const nineAndEight = [...moments, ...moments8pm].sort((a, b) => a.t - b.t);
// 8:30 AM and 8:30 PM PHT (00:30 and 12:30 UTC)
const halfPastEight = [...momentsAt(0, 30), ...momentsAt(12, 30)].sort((a, b) => a.t - b.t);
// 8:00 AM and 9:00 AM PHT
const eightAndNine = [...momentsAt(0), ...moments].sort((a, b) => a.t - b.t);
// 9:00 AM and 8:30 PM PHT
const nineAndHalfPastEight = [...moments, ...momentsAt(12, 30)].sort((a, b) => a.t - b.t);
console.log(`${moments.length} 9:00 AM PHT moments, ${moments8pm.length} 8:00 PM PHT moments; target $${TARGET}, lot ${LOT}, held up to ${HOLD_DAYS} days, swap long $${SWAP.buy} / short $${SWAP.sell} per lot per night`);

/** Hedge trigger for a side: $0.50 past its S/R boundary, at least $2.50 and at most the $20 cap away. */
const triggerFor = (dir, entry, lvl, slD, lot, maxLoss) => {
  const raw = dir === "buy" ? lvl.support - 0.5 : lvl.resistance + 0.5;
  const dist = Math.max(2.50, Math.min(Math.abs(entry - raw), maxTrigDist(lot, maxLoss)));
  return Math.max(0.01, Math.min(0.99, dist / slD));
};

// Broker rollovers (server midnight) between two server times: Monday to Friday nights,
// Wednesday's counts 3 (the weekend), none on Saturday and Sunday nights
const nights = (from, to) => {
  let n = 0;
  for (let day = Math.floor(from / 86400) + 1; day * 86400 <= to; day++) {
    const weekday = new Date(day * 86400 * 1000).getUTCDay();   // day the rollover starts
    n += weekday === 4 ? 3 : weekday === 0 || weekday === 1 ? 0 : 1;
  }
  return n;
};
const legSwap = (dir, from, to, lot) => nights(from, to) * SWAP[dir] * lot;
const opposite = (dir) => (dir === "buy" ? "sell" : "buy");

/** Last 5-minute close before a server time. */
const priceAt = (t) => m5.close[Math.max(0, lowerBound(m5.time, t) - 1)];

/**
 * One side of a moment, held until SL or TP: the walk plus its own trigger, when it
 * closed (server seconds) and the overnight swap of each leg ($, at the rule's lot):
 * primary, hedge (from its fill), and opposite_full (the other side open the whole
 * time, for the normal-hedge comparison).
 */
const gradeSide = (m, dir, lvl, slD, tpD, lot, maxLoss) => {
  const trigger = triggerFor(dir, m5.open[m.i0], lvl, slD, lot, maxLoss);
  const w = walk(m5, m.i0, dir, slD, tpD, trigger, HOLD_SEC, { carryWeekend: true });
  const t0 = m5.time[m.i0];
  const closeAt = w.hours != null ? t0 + w.hours * 3600 : t0 + HOLD_SEC;
  const swap = {
    primary: r2(legSwap(dir, t0, closeAt, lot)),
    hedge: w.hedge ? r2(legSwap(opposite(dir), t0 + w.hedge.hours * 3600, closeAt, lot)) : 0,
    opposite_full: r2(legSwap(opposite(dir), t0, closeAt, lot)),
  };
  return { grade: { ...w, trigger, swap }, closeAt };
};

const nearSupport = (pos) => pos <= 0.25;
const nearResistance = (pos) => pos >= 0.75;
const pastScoreOf = (m) => m.micro?.recommend_all ?? 0;

// Each rule picks a side for a moment and says whether it would trade (take);
// extra goes into inputs.rule. The S/R budget check and the one-pair check apply to all.
const RULES = [
  ...FS.map((f) => ({
    run: `sr-budget-${Math.round(f * 100)}`, name: "sr-budget", picker: "sr-bounce", f,
    // Support -> buy, resistance -> sell, unless the past chart is strongly against it
    pick: (m, pos) => {
      const isNear = nearSupport(pos) || nearResistance(pos);
      const counter = (nearSupport(pos) && pastScoreOf(m) < -0.2) || (nearResistance(pos) && pastScoreOf(m) > 0.2);
      return { dir: pos <= 0.5 ? "buy" : "sell", take: isNear && !counter, extra: { is_near_boundary: isNear, past_counter_trend: counter } };
    },
  })),
  {
    run: "sr-tv-combined", name: "sr-tv-synergy", picker: "sr-tv-synergy", f: 0.15,
    // TradingView's side, entered on a pullback into the S/R range
    pick: (m, pos) => {
      const dir = m.rating === "buy" && pos <= 0.45 ? "buy" : m.rating === "sell" && pos >= 0.55 ? "sell" : null;
      return { dir: dir || (pos <= 0.5 ? "buy" : "sell"), take: dir !== null };
    },
  },
  {
    run: "sr-adaptive", name: "sr-adaptive", picker: "sr-adaptive", f: 0.12,
    // Near a boundary: the bounce if TradingView agrees, else the breakout (= TradingView's side)
    pick: (m, pos) => {
      const isNear = nearSupport(pos) || nearResistance(pos);
      const confluence = (nearSupport(pos) && m.rating === "buy") || (nearResistance(pos) && m.rating === "sell");
      const bounce = nearSupport(pos) ? "buy" : "sell";
      const dir = !isNear ? (pos <= 0.5 ? "buy" : "sell") : confluence ? bounce : opposite(bounce);
      return { dir, take: isNear, extra: { is_near_boundary: isNear, adaptive_regime: confluence ? "BOUNCE" : "BREAKOUT" } };
    },
  },
  {
    run: "sr-tv-30d", name: "sr-tv-30d", picker: "sr-tv-30d", f: 0.15, levels: (m) => m.levels6,
    // TradingView pullback, only in the direction of the 30-day trend; 6-hour levels
    pick: (m, pos) => {
      const m30 = m.macro30d;
      const allowBuy = !m30 || m30.isBullish, allowSell = !m30 || !m30.isBullish;
      const dir = allowBuy && m.rating === "buy" && pos <= 0.45 ? "buy" : allowSell && m.rating === "sell" && pos >= 0.55 ? "sell" : null;
      const fallback = m30 ? (m30.isBullish ? "buy" : "sell") : pos <= 0.5 ? "buy" : "sell";
      return { dir: dir || fallback, take: dir !== null, extra: { macro_30d_trend: m30?.isBullish ? "BULLISH" : "BEARISH", macro_30d_net: r2(m30?.net30d ?? 0) } };
    },
  },
  {
    run: "sr-bounce", name: "sr-bounce", picker: "sr-bounce", f: 0.15,
    // Plain bounce: bottom 25% of the range -> buy, top 25% -> sell; no TradingView or trend check
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: nearSupport(pos) || nearResistance(pos) }),
  },
  // Plain bounce at the x12% ($40 stop) and x20% ($66.67 stop) budgets, with 12h, 6h and 2h S/R levels
  ...[[0.12, "40"], [0.2, "20"]].flatMap(([f, tag]) => [
    { suffix: "", levels: null },
    { suffix: "-6h", levels: (m) => m.levels6 },
    { suffix: "-2h", levels: (m) => m.levels2 },
  ].map((v) => ({
    run: `sr-bounce-${tag}${v.suffix}`, name: "sr-bounce", picker: "sr-bounce", f, ...(v.levels && { levels: v.levels }),
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: nearSupport(pos) || nearResistance(pos) }),
  }))),
  // x12% bounce, only on the side of the month's direction (up: buy at support, down: sell
  // at resistance). "m30" = price now vs 30 days ago (usable live); "month" = the calendar
  // month's actual direction (hindsight: an upper bound, can't be traded)
  ...[
    { suffix: "-2h", levels: (m) => m.levels2 },
    { suffix: "", levels: null },
  ].flatMap((v) => [
    { bias: "m30", side: (m) => (m.macro30d ? (m.macro30d.net30d >= 0 ? "buy" : "sell") : null) },
    { bias: "month", side: (m) => m.month ?? null },
  ].map((b) => ({
    run: `sr-bounce-40${v.suffix}-${b.bias}`, name: "sr-bounce", picker: "sr-bounce", f: 0.12, ...(v.levels && { levels: v.levels }),
    pick: (m, pos) => {
      const side = b.side(m);
      const dir = pos <= 0.5 ? "buy" : "sell";
      const zone = nearSupport(pos) || nearResistance(pos);
      return { dir, take: zone && side === dir, extra: { month_bias: side, bias_source: b.bias } };
    },
  }))),
  // Same x12% bounce checked twice a day: 9:00 AM and 8:00 PM PHT (still one pair at a time)
  {
    run: "sr-bounce-40-9am-8pm", name: "sr-bounce", picker: "sr-bounce", f: 0.12, moments: nineAndEight,
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: nearSupport(pos) || nearResistance(pos) }),
  },
  // Bigger and smaller sizes of the plain 9 AM bounce (12h levels, 25% zone):
  //   lot 0.1, same trade as x12% at 0.03 ($40 stop, $400 budget), hedged-loss cap scaled to $66.67
  //   lot 0.01 with a x10% budget ($100 -> a $100 stop), $20 cap
  {
    run: "sr-bounce-lot10", name: "sr-bounce", picker: "sr-bounce", f: 0.4, lot: 0.1, maxLoss: (20 * 0.1) / 0.03,
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: nearSupport(pos) || nearResistance(pos) }),
  },
  {
    run: "sr-bounce-lot01-x10", name: "sr-bounce", picker: "sr-bounce", f: 0.1, lot: 0.01,
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: nearSupport(pos) || nearResistance(pos) }),
  },
  // 30-day bias (buy only when gold is up over 30 days, sell only when down), 12h levels,
  // x12% budget, at 0.02 and 0.03 lot, at 9 AM, 9 AM + 8 PM, and 9 AM + 8 AM
  ...[[0.02, "02"], [0.03, "03"]].flatMap(([lot, lotTag]) => [
    { times: "", moments },
    { times: "-9am-8pm", moments: nineAndEight },
    { times: "-8am-9am", moments: eightAndNine },
  ].map((v) => ({
    run: `sr-bounce-m30-lot${lotTag}${v.times}`, name: "sr-bounce", picker: "sr-bounce", f: 0.12, lot, moments: v.moments,
    pick: (m, pos) => {
      const side = m.macro30d ? (m.macro30d.net30d >= 0 ? "buy" : "sell") : null;
      const dir = pos <= 0.5 ? "buy" : "sell";
      return { dir, take: (nearSupport(pos) || nearResistance(pos)) && side === dir, extra: { month_bias: side, bias_source: "m30" } };
    },
  }))),
  // 9 AM + 8:30 PM (8:30 PM Manila = 8:30 AM New York in US summer time, the US data minute)
  {
    run: "sr-bounce-40-9am-830pm", name: "sr-bounce", picker: "sr-bounce", f: 0.12, moments: nineAndHalfPastEight,
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: nearSupport(pos) || nearResistance(pos) }),
  },
  // 9 AM + 8 PM with the wider 40% zone
  {
    run: "sr-bounce-40-9am-8pm-z40", name: "sr-bounce", picker: "sr-bounce", f: 0.12, moments: nineAndEight,
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: pos <= 0.4 || pos >= 0.6, extra: { zone: 0.4 } }),
  },
  // x12% bounce at 8:30 AM and 8:30 PM PHT, with the 25% zone and a wider 40% zone
  ...[[0.25, ""], [0.4, "-z40"]].map(([zone, tag]) => ({
    run: `sr-bounce-40-830${tag}`, name: "sr-bounce", picker: "sr-bounce", f: 0.12, moments: halfPastEight,
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: pos <= zone || pos >= 1 - zone, extra: { zone } }),
  })),
  // Same x12% bounce with a tighter zone: bottom/top 20% of the range instead of 25%
  ...[
    { suffix: "", levels: null },
    { suffix: "-6h", levels: (m) => m.levels6 },
    { suffix: "-2h", levels: (m) => m.levels2 },
  ].map((v) => ({
    run: `sr-bounce-40-z20${v.suffix}`, name: "sr-bounce", picker: "sr-bounce", f: 0.12, ...(v.levels && { levels: v.levels }),
    pick: (m, pos) => ({ dir: pos <= 0.5 ? "buy" : "sell", take: pos <= 0.2 || pos >= 0.8 }),
  })),
];

const fmt = (b) => `${b.a}/${b.graded} clean TP, ${b.pnl >= 0 ? "+" : ""}$${b.pnl}`;

for (const rule of RULES) {
  const lot = rule.lot ?? LOT;
  const budget = TARGET * rule.f, slD = budget / (lot * 100);
  let busyUntil = 0, busyCount = 0;
  const records = (rule.moments ?? moments).map((m) => {
    const lvl = rule.levels ? rule.levels(m) : m.levels;
    const entry = m5.open[m.i0];
    const pos = lvl.range > 0 ? (entry - lvl.support) / lvl.range : 0.5;
    const { dir, take, extra = {} } = rule.pick(m, pos);
    const tpDistance = Math.max(lvl.range, 5.0);
    const main = gradeSide(m, dir, lvl, slD, tpDistance, lot, rule.maxLoss);

    // One pair of accounts: a signal while the last pair is still open can't be traded
    const wants = take && lvl.range * lot * 100 < budget;
    const busy = wants && m5.time[m.i0] < busyUntil;
    const passed = wants && !busy;
    if (passed) busyUntil = main.closeAt;
    if (busy) busyCount++;

    const row = {
      created_at: new Date(serverToUtcMs(m.t)).toISOString(),
      direction: dir, tv_direction: m.rating, coin_direction: m.coin, confidence: null,
      grade: { sl_distance: slD, tp_distance: tpDistance },
    };
    const rec = replayRecord(row, m5, m.i0, rule.run);
    rec.grade.mark_price = priceAt(m5.time[m.i0] + HOLD_SEC);   // for trades still open at the end of the hold
    rec.grade.results.ai.main = main.grade;
    rec.grade.results.tv.main = gradeSide(m, m.rating, lvl, slD, tpDistance, lot, rule.maxLoss).grade;
    rec.grade.results.coin.main = gradeSide(m, m.coin, lvl, slD, tpDistance, lot, rule.maxLoss).grade;
    rec.grade.results.opp = { main: gradeSide(m, opposite(dir), lvl, slD, tpDistance, lot, rule.maxLoss).grade };

    const s = dir === "buy" ? 1 : -1;
    rec.inputs = {
      picker: rule.picker,
      trigger: main.grade.trigger,
      rule: {
        name: rule.name, passed, busy, f: rule.f, target: TARGET, lot, budget, sl_distance: r2(slD),
        window_hours: lvl.hours, pump_dump: lvl.pump,
        support: r2(lvl.support), resistance: r2(lvl.resistance), range: r2(lvl.range), range_dollars: r2(lvl.range * lot * 100),
        trigger_price: r2(entry - s * main.grade.trigger * slD),
        max_loss_cap: rule.maxLoss ?? MAX_LOSS_DOLLARS,
        proximity_pct: r2(pos * 100),
        is_near_boundary: nearSupport(pos) || nearResistance(pos),
        past_trend: m.rating,
        past_score: r2(pastScoreOf(m)),
        past_counter_trend: false,
        hold_days: HOLD_DAYS, swap_long: SWAP.buy, swap_short: SWAP.sell,
        us_news_at: newsBetween(m5.time[m.i0], main.closeAt).map((t) => new Date(serverToUtcMs(t)).toISOString()),
        ...extra,
      },
    };
    return rec;
  });

  const taken = records.filter((r) => r.inputs.rule.passed);
  const board = scoreboard(taken, "main");
  const luck = luckTest(taken, "main");
  console.log(`\n${rule.run}: budget $${budget}, stop $${slD.toFixed(2)}; takes ${taken.length} of ${records.length} (${busyCount} skipped: pair still open)`);
  console.log(`  taken    rule ${fmt(board.ai)} | one coin ${fmt(board.coin)}`);
  if (luck) console.log(`  luck     beats ${luck.beats_pct}% of ${luck.coin_runs} coin flips (median $${luck.coin_pnl.median}); halves $${luck.halves[0].pnl} / $${luck.halves[1].pnl}; with $${luck.slippage.per_hedge} slippage $${luck.slippage.pnl}`);
  if (SAVE) {
    await saveReplay(records);
    console.log(`  saved ${records.length} rows as run "${rule.run}"`);
  }
}

if (!SAVE) console.log("\nDry run. Add --save to store the runs for the dashboard.");
