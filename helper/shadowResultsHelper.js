// Summarises graded signals: how often each direction source (the AI, the
// TradingView rating alone, a coin flip) hit TP without the delayed hedge opening
// (story A), per score range, next to what luck alone gives.

export const SCORE_BUCKETS = [
  { label: "80+", min: 80, max: Infinity },
  { label: "70-79", min: 70, max: 80 },
  { label: "50-69", min: 50, max: 70 },
  { label: "under 50", min: -Infinity, max: 50 },
];
export const SOURCES = ["ai", "tv", "coin"];

// Shadow signals aren't traded, so the monitor shows the trade the system would
// open: lot from the auto-sizing rule for a fixed $ risk (same 0.30 cap as the
// pairing screen), TP = SL distance, equal-lot hedge at a 10% dip.
export const REFERENCE_RISK = 100;
export const MAX_AUTO_LOT = 0.3;

// Trading cost per account that trades, per 1.0 lot (spread, commission, the backup's
// slightly wider SL / smaller TP). Measured from the real normal-hedge pairs in
// paired_trading_accounts (setTradingCost); this default is what they showed in Oct 2026.
let legCostPerLot = 40;
let costSource = { pairs: 4, measured: true, per_pair_example: null };
export const setTradingCost = (perLot, source) => {
  if (Number.isFinite(perLot) && perLot > 0 && perLot < 500) { legCostPerLot = perLot; costSource = source; }
};
export const tradingCost = () => ({ per_lot_per_account: Math.round(legCostPerLot * 10) / 10, ...costSource });
const CONTRACT = 100;   // XAUUSD: $ per 1.00 move per 1.0 lot
const TRIGGER = 0.1;
const autoLot = (slDistance) => Math.min(MAX_AUTO_LOT, Math.max(0.01, Math.round((REFERENCE_RISK / (slDistance * CONTRACT)) * 100) / 100));

/**
 * Lot and TP a graded row was tested with. Only the "main" grade has them: past-data runs
 * graded at their own TP (grade.tp_distance) and, for the S/R rules, a fixed lot (rule.lot).
 * Other settings keep the reference sizing (lot for $100 risk, TP = SL).
 */
export const sizingOf = (r, setting) => setting !== "main" ? {} : {
  tpDistance: Number(r.grade?.tp_distance) || null,
  lot: Number(r.rule?.lot ?? r.inputs?.rule?.lot) || null,
};

/**
 * The trade a signal stands for. With a grade (story), also how it closed:
 *   A  closed at TP, only the primary open             -> +risk
 *   B  hedge opened at the trigger, closed at the SL   -> -10% of risk (pair)
 *   C  hedge opened at the trigger, closed at the TP   -> -10% of risk (pair)
 *   X  still open at the horizon: closed at the market price then (markPrice);
 *      locked at -10% if the hedge had opened (mae >= 10% of the SL distance),
 *      known even without a price, since SL and TP both end the pair there
 * swap: overnight swap $ the grade recorded for each leg ({ primary, hedge }), when
 * the replay held the trade over rollovers
 */
export const referenceTrade = (direction, entry, slDistance, story = null, { mae = null, markPrice = null, hedge = null, trigger: trig = TRIGGER, tpDistance = null, lot: fixedLot = null, swap = null } = {}) => {
  if (!(slDistance > 0) || !(entry > 0)) return null;
  const s = direction === "buy" ? 1 : -1;
  // A run with its own lot and TP (the S/R rules: 0.03 lot, TP = S/R range) is priced with
  // them; otherwise the lot is sized to REFERENCE_RISK and TP = SL distance
  const lot = fixedLot > 0 ? fixedLot : autoLot(slDistance);
  const risk = lot * slDistance * CONTRACT;   // $ at the SL
  const r2 = (x) => Math.round(x * 100) / 100;
  const sl = entry - s * slDistance, tp = entry + s * (tpDistance > 0 ? tpDistance : slDistance), trigger = entry - s * trig * slDistance;

  // Two accounts: the primary (signal direction) and the hedge (opposite, same lot),
  // opened at its fill (usually the trigger; worse after a jump) and closed with the primary.
  let close = null, hedged = null;
  if (story === "A") { close = tp; hedged = false; }
  else if (story === "B") { close = sl; hedged = true; }
  else if (story === "C") { close = tp; hedged = true; }
  else if (story === "X") { hedged = (mae != null && mae >= trig) || !!hedge; if (markPrice > 0) close = markPrice; }
  const fill = hedge?.price > 0 ? hedge.price : trigger;
  const cost = legCostPerLot * lot;   // each account that trades pays this
  const swapPrimary = Number(swap?.primary) || 0, swapHedge = hedged ? Number(swap?.hedge) || 0 : 0;
  const primaryPnl = close === null ? null : (close - entry) * s * lot * CONTRACT - cost + swapPrimary;
  const hedgePnl = close === null ? null : hedged ? (close - fill) * -s * lot * CONTRACT - cost + swapHedge : 0;
  const locked = (fill - entry) * s * lot * CONTRACT - 2 * cost + swapPrimary + swapHedge;
  const net = primaryPnl !== null ? primaryPnl + hedgePnl : story === "X" && hedged ? locked : null;
  // Slippage: how much worse the hedge opened than planned, as % of the planned loss
  // (planned = the trigger dip, 10% by default; e.g. planned -$10, opened at -$14 -> 40%)
  // (both from cent-rounded prices, so a fill exactly at the trigger reads 0%)
  const plannedLoss = Math.abs(r2(trigger) - r2(entry)), actualLoss = Math.abs(r2(fill) - r2(entry));
  const slippagePct = hedged ? Math.round(((actualLoss - plannedLoss) / plannedLoss) * 1000) / 10 : null;
  return {
    slippage_pct: slippagePct,
    lot, risk: r2(risk), entry: r2(entry), sl: r2(sl), tp: r2(tp), trigger: r2(trigger),
    close: close === null ? null : r2(close), hedged,
    primary_pnl: primaryPnl === null ? null : r2(primaryPnl),
    hedge_pnl: hedgePnl === null ? null : r2(hedgePnl),
    pnl: net === null ? null : r2(net),
    swap: swap ? r2(swapPrimary + swapHedge) : null,
    hedge_price: hedged ? r2(fill) : null, hedge_hours: hedge?.hours ?? null,
  };
};

/**
 * The same trade with NORMAL hedging: both accounts open together (same lot,
 * opposite sides, mirrored TP/SL), so whichever way price goes one account wins
 * what the other loses. Main = signal direction, backup = the opposite side.
 */
export const naturalTrade = (direction, entry, slDistance, story, { markPrice = null, tpDistance = null, lot: fixedLot = null, swap = null } = {}) => {
  if (!(slDistance > 0) || !(entry > 0)) return null;
  const s = direction === "buy" ? 1 : -1;
  const lot = fixedLot > 0 ? fixedLot : autoLot(slDistance);
  const risk = lot * slDistance * CONTRACT;
  let main = null;
  if (story === "A" || story === "C") main = lot * (tpDistance > 0 ? tpDistance : slDistance) * CONTRACT;   // price reached the main's TP
  else if (story === "B") main = -risk;                      // price reached the main's SL
  else if (story === "X" && markPrice > 0) main = (markPrice - entry) * s * lot * CONTRACT;
  if (main === null) return null;
  const r2 = (x) => Math.round(x * 100) / 100;
  const cost = legCostPerLot * lot;   // both accounts always trade
  // Both legs stay open the whole time: the main's swap, and the backup's for the opposite side
  const swapMain = Number(swap?.primary) || 0, swapBackup = Number(swap?.opposite_full) || 0;
  return { lot, main: r2(main - cost + swapMain), backup: r2(-main - cost + swapBackup), net: r2(-2 * cost + swapMain + swapBackup) };
};

// Price at the 8-hour mark: stored with replay grades, attached by the caller for live rows
const markOf = (r) => Number(r.grade?.mark_price) || Number(r.mark_price) || null;
// Hedge trigger of the row's setting (past-data runs can test other triggers)
const triggerOf = (r) => Number(r.trigger ?? r.inputs?.trigger) || TRIGGER;

/** referenceTrade options for one graded side of a row (its own trigger and swap when the grade has them). */
export const gradeOpts = (r, g, setting) => ({
  hedge: g.hedge ?? null, mae: g.mae ?? null, markPrice: markOf(r),
  trigger: Number(g.trigger) || triggerOf(r), swap: g.swap ?? null, ...sizingOf(r, setting),
});

/**
 * Delayed hedge vs normal hedge over the same AI trades (finished, or unfinished
 * with a known result), oldest first: totals per account and a running total for the chart.
 */
export const strategyComparison = (rows, setting = "t10_tp1") => {
  const totals = {
    delayed: { net: 0, main: 0, backup: 0, backup_used: 0 },
    natural: { net: 0, main: 0, backup: 0, backup_used: 0 },
  };
  const series = [];
  let trades = 0;
  const sorted = [...rows].sort((a, b) => new Date(a.created_at ?? a.moment) - new Date(b.created_at ?? b.moment));
  for (const r of sorted) {
    const g = r.grade?.results?.ai?.[setting];
    if (!g || !r.direction) continue;
    const entry = Number(r.grade.entry_price) || Number(r.entry_price), sl = Number(r.grade.sl_distance);
    const d = referenceTrade(r.direction, entry, sl, g.story, gradeOpts(r, g, setting));
    const n = naturalTrade(r.direction, entry, sl, g.story, { markPrice: markOf(r), swap: g.swap ?? null, ...sizingOf(r, setting) });
    if (!d || d.pnl === null || d.primary_pnl === null || !n) continue;
    trades++;
    totals.delayed.net += d.pnl; totals.delayed.main += d.primary_pnl; totals.delayed.backup += d.hedge_pnl;
    if (d.hedged) totals.delayed.backup_used++;
    totals.natural.main += n.main; totals.natural.backup += n.backup; totals.natural.net += n.net;
    totals.natural.backup_used++;
    series.push({ t: r.created_at ?? r.moment, delayed: Math.round(totals.delayed.net * 100) / 100, natural: Math.round(totals.natural.net * 100) / 100 });
  }
  const r2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { trades, delayed: r2(totals.delayed), natural: r2(totals.natural), series };
};

const COIN_RUNS = 1000;
// Extra $ price move per hedge for the slippage check (live hedges filled ~40% past a $10 dip)
export const SLIPPAGE_TEST = 1.5;

/**
 * Is the picker better than luck? Needs past-data rows that also graded the opposite side
 * (grade.results.opp.main, with its own trigger). Replays COIN_RUNS coin flips over the
 * same moments, each picking a random side, and places the picker's total among them.
 * Also: the picker's $ in each half of the period and with SLIPPAGE_TEST per hedge.
 */
export const luckTest = (rows, setting = "main") => {
  const pairs = [];
  for (const r of rows) {
    const g = r.grade?.results?.ai?.[setting], o = r.grade?.results?.opp?.[setting];
    if (!g || !o || !r.direction) continue;
    const entry = Number(r.grade.entry_price) || Number(r.entry_price), sl = Number(r.grade.sl_distance);
    const mine = referenceTrade(r.direction, entry, sl, g.story, gradeOpts(r, g, setting));
    const other = referenceTrade(r.direction === "buy" ? "sell" : "buy", entry, sl, o.story, gradeOpts(r, o, setting));
    if (mine?.pnl == null || other?.pnl == null) continue;
    pairs.push({ t: new Date(r.created_at ?? r.moment).getTime(), mine, other, a: g.story === "A", oa: o.story === "A" });
  }
  if (pairs.length < 5) return null;
  pairs.sort((x, y) => x.t - y.t);

  const total = pairs.reduce((s, p) => s + p.mine.pnl, 0);
  const clean = pairs.filter((p) => p.a).length;
  let seed = 12345;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const coinPnl = [], coinClean = [];
  for (let k = 0; k < COIN_RUNS; k++) {
    let pnl = 0, a = 0;
    for (const p of pairs) {
      const pickMine = rand() < 0.5;
      pnl += pickMine ? p.mine.pnl : p.other.pnl;
      a += (pickMine ? p.a : p.oa) ? 1 : 0;
    }
    coinPnl.push(pnl); coinClean.push(a);
  }
  coinPnl.sort((x, y) => x - y); coinClean.sort((x, y) => x - y);
  const at = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  // Share of coin runs the picker beats (ties count half)
  const beats = (arr, v) => Math.round(((arr.filter((x) => x < v).length + arr.filter((x) => x === v).length / 2) / arr.length) * 100);
  const r2 = (x) => Math.round(x * 100) / 100;

  const half = Math.ceil(pairs.length / 2);
  const sum = (list) => r2(list.reduce((s, p) => s + p.mine.pnl, 0));
  const hedges = pairs.filter((p) => p.mine.hedged).reduce((s, p) => s + p.mine.lot, 0);
  return {
    trades: pairs.length, coin_runs: COIN_RUNS,
    pnl: r2(total), beats_pct: beats(coinPnl, total),
    coin_pnl: { p5: r2(at(coinPnl, 0.05)), median: r2(at(coinPnl, 0.5)), p95: r2(at(coinPnl, 0.95)) },
    clean, clean_beats_pct: beats(coinClean, clean), coin_clean_median: at(coinClean, 0.5),
    halves: [
      { from: new Date(pairs[0].t).toISOString(), pnl: sum(pairs.slice(0, half)) },
      { from: new Date(pairs[half]?.t ?? pairs[0].t).toISOString(), pnl: sum(pairs.slice(half)) },
    ],
    slippage: { per_hedge: SLIPPAGE_TEST, pnl: r2(total - hedges * SLIPPAGE_TEST * CONTRACT) },
  };
};

/**
 * Totals over graded signals for each source: A/B/C/X counts and the $ result at
 * REFERENCE_RISK. Unfinished trades count when their result is known: locked at -10%
 * once hedged, or at the 8-hour price.
 */
export const scoreboard = (rows, setting = "t10_tp1") => {
  const out = {};
  for (const src of SOURCES) {
    const t = { graded: 0, a: 0, b: 0, c: 0, x: 0, pnl: 0, slip_sum: 0, slip_n: 0, slip_max: 0 };
    for (const r of rows) {
      const g = r.grade?.results?.[src]?.[setting];
      const dir = src === "ai" ? r.direction : src === "tv" ? r.tv_direction : r.coin_direction;
      if (!g || !dir) continue;
      t.graded++;
      const story = g.story;
      const trade = referenceTrade(dir, Number(r.grade.entry_price) || Number(r.entry_price), Number(r.grade.sl_distance), story,
        gradeOpts(r, g, setting));
      if (trade?.pnl != null) t.pnl += trade.pnl;
      if (trade?.slippage_pct != null) { t.slip_sum += trade.slippage_pct; t.slip_n++; t.slip_max = Math.max(t.slip_max, trade.slippage_pct); }

      // Fully resolve all trades instantly (no unfinished limbo):
      if (story === "A") {
        t.a++;
      } else if (story === "B" || (story === "X" && (trade?.pnl ?? 0) <= 0)) {
        t.b++;
      } else {
        t.c++;
      }
    }
    const resolved = t.graded;
    const { slip_sum, slip_n, slip_max, ...rest } = t;
    out[src] = {
      ...rest, x: 0, resolved, pnl: Math.round(t.pnl * 100) / 100,
      a_rate: resolved ? Math.round((t.a / resolved) * 1000) / 10 : null,
      a_rate_all: resolved ? Math.round((t.a / resolved) * 1000) / 10 : null,
      hedges: slip_n, slippage_avg_pct: slip_n ? Math.round((slip_sum / slip_n) * 10) / 10 : null, slippage_max_pct: slip_n ? slip_max : null,
    };
  }
  return out;
};
/**
 * TP without the hedge per day (UTC days that had signals), two ways:
 *   every          every signal traded, even while earlier ones are still open
 *   one_at_a_time  the next trade opens only once the last one has closed (or after
 *                  8h if it never finished): what a single pair of accounts can do
 */
export const dailyBreakdown = (rows, setting = "t10_tp1") => {
  const trades = rows.map((r) => {
    const g = r.grade?.results?.ai?.[setting];
    if (!g || !r.direction) return null;
    const d = referenceTrade(r.direction, Number(r.grade.entry_price) || Number(r.entry_price), Number(r.grade.sl_distance), g.story,
      gradeOpts(r, g, setting));
    const resolvedStory = g.story === "X" ? ((d?.pnl ?? 0) >= 0 ? "C" : "B") : g.story;
    return { t: new Date(r.created_at ?? r.moment).getTime(), story: resolvedStory, hours: g.hours ?? 8, pnl: d?.pnl ?? null };
  }).filter(Boolean).sort((a, b) => a.t - b.t);

  let free = -Infinity;
  const sequential = trades.filter((x) => {
    if (x.t < free) return false;
    free = x.t + x.hours * 3600 * 1000;
    return true;
  });

  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const tradingDays = [...new Set(trades.map((x) => dayOf(x.t)))];
  const group = (list) => {
    const byDay = new Map(tradingDays.map((date) => [date, { date, trades: 0, a: 0, b: 0, c: 0, x: 0, pnl: 0 }]));
    for (const x of list) {
      const d = byDay.get(dayOf(x.t));
      d.trades++;
      d[x.story.toLowerCase()]++;
      if (x.pnl != null) d.pnl += x.pnl;
    }
    const days = [...byDay.values()].map((d) => ({ ...d, pnl: Math.round(d.pnl * 100) / 100 }));
    const n = days.length || 1;
    const sum = (k) => days.reduce((acc, d) => acc + d[k], 0);
    return {
      days,
      summary: {
        days: days.length,
        trades_per_day: Math.round((sum("trades") / n) * 10) / 10,
        a_per_day: Math.round((sum("a") / n) * 100) / 100,
        pnl_per_day: Math.round((sum("pnl") / n) * 100) / 100,
        best_day: days.reduce((m, d) => Math.max(m, d.a), 0),
        days_by_tp: {
          0: days.filter((d) => d.a === 0).length,
          1: days.filter((d) => d.a === 1).length,
          2: days.filter((d) => d.a === 2).length,
          "3+": days.filter((d) => d.a >= 3).length,
        },
      },
    };
  };
  return { every: group(trades), one_at_a_time: group(sequential) };
};

// Signals of the same direction within this window count as one independent call
const INDEPENDENT_GAP_MS = 4 * 3600 * 1000;

const emptyTally = () => ({ graded: 0, resolved: 0, a: 0, b: 0, c: 0, x: 0, independent: 0 });

const finish = (t) => ({
  ...t,
  a_rate: t.resolved ? Math.round((t.a / t.resolved) * 1000) / 10 : null,       // % of resolved
  win_rate: t.resolved ? Math.round(((t.a + t.c) / t.resolved) * 1000) / 10 : null,
});

/**
 * @param {object[]} rows   market_signals rows with created_at, confidence, score_v2, grade
 * @param {string} setting  grade key, e.g. "t10_tp1" (10% trigger, TP = SL) or "t15_tpai"
 * @param {"v1"|"v2"} scoreVersion which score the buckets use
 */
export const summarizeGrades = (rows, setting = "t10_tp1", scoreVersion = "v1") => {
  const [, trigPart, tpPart] = setting.match(/^t(\d+)_(tp1|tpai)$/) || [];
  const trigger = Number(trigPart) / 100 || 0.1;
  const scoreOf = (r) => Number(scoreVersion === "v2" ? r.score_v2 : r.confidence);

  const buckets = SCORE_BUCKETS.map((b) => ({ label: b.label, sources: Object.fromEntries(SOURCES.map((s) => [s, emptyTally()])) }));
  const overall = Object.fromEntries(SOURCES.map((s) => [s, emptyTally()]));
  const lastCounted = {};   // per bucket+source: { at, direction } of the last independent call
  let rewardRiskSum = 0;
  let rewardRiskN = 0;

  const graded = rows
    .filter((r) => r.grade?.results)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  for (const r of graded) {
    const score = scoreOf(r);
    const bi = SCORE_BUCKETS.findIndex((b) => score >= b.min && score < b.max);
    if (bi < 0) continue;
    if (r.grade.sl_distance > 0) {
      rewardRiskSum += tpPart === "tp1" ? 1 : r.grade.tp_distance / r.grade.sl_distance;
      rewardRiskN++;
    }
    for (const s of SOURCES) {
      const g = r.grade.results[s]?.[setting];
      if (!g) continue;
      const direction = s === "ai" ? r.direction : s === "tv" ? r.tv_direction : r.coin_direction;
      const storyResolved = g.story === "X" ? "b" : g.story.toLowerCase();
      for (const tally of [buckets[bi].sources[s], overall[s]]) {
        tally.graded++;
        tally[storyResolved]++;
        tally.resolved++;
      }
      const at = new Date(r.created_at).getTime();
      for (const key of [`${bi}:${s}`, `all:${s}`]) {
        const last = lastCounted[key];
        if (!last || at - last.at >= INDEPENDENT_GAP_MS || last.direction !== direction) {
          lastCounted[key] = { at, direction };
          (key.startsWith("all") ? overall[s] : buckets[bi].sources[s]).independent++;
        }
      }
    }
  }

  // Luck: with no edge, story A happens trigger / (TP size + trigger) of the time
  const rewardRisk = rewardRiskN ? rewardRiskSum / rewardRiskN : 1;
  const luck = Math.round((trigger / (rewardRisk + trigger)) * 1000) / 10;

  // Tracked support/resistance checks (r.sr.checks): the AI's results when each passed vs not
  const checks = {};
  const lastCheckCounted = {};
  for (const r of graded) {
    const g = r.grade.results.ai?.[setting];
    if (!g || !r.sr?.checks) continue;
    const at = new Date(r.created_at).getTime();
    for (const [key, passed] of Object.entries(r.sr.checks)) {
      checks[key] ??= { passed: emptyTally(), failed: emptyTally() };
      const side = passed ? "passed" : "failed";
      const tally = checks[key][side];
      const storyResolved = g.story === "X" ? "b" : g.story.toLowerCase();
      tally.graded++;
      tally[storyResolved]++;
      tally.resolved++;
      // Same rule as the score table: same direction within 4 hours = one independent call
      const last = lastCheckCounted[`${key}:${side}`];
      if (!last || at - last.at >= INDEPENDENT_GAP_MS || last.direction !== r.direction) {
        lastCheckCounted[`${key}:${side}`] = { at, direction: r.direction };
        tally.independent++;
      }
    }
  }

  return {
    setting,
    score_version: scoreVersion,
    luck_a_rate: luck,
    signals: graded.length,
    checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { passed: finish(v.passed), failed: finish(v.failed) }])),
    overall: Object.fromEntries(SOURCES.map((s) => [s, finish(overall[s])])),
    buckets: buckets.map((b) => ({ label: b.label, sources: Object.fromEntries(SOURCES.map((s) => [s, finish(b.sources[s])])) })),
  };
};

/** Diagnostic tags for understanding trade failure and execution context */
export const getTradeDiagnostic = ({ time, entry, rule, story, hedged, direction }) => {
  const d = new Date(time);
  const hour = d.getUTCHours();
  const nyHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(d));

  // Market session; the broker's daily rollover (and swap) is 17:00-18:00 New York time
  let session = "Asian";
  if (nyHour === 17) session = "Rollover";
  else if (hour >= 7 && hour < 12) session = "London";
  else if (hour >= 12 && hour < 17) session = "New York";
  else if (hour >= 17 && hour < 22) session = "Late NY";

  // Location relative to S/R
  let location = null;
  let posPct = null;
  if (rule?.support != null && rule?.resistance != null && rule.resistance > rule.support && entry != null) {
    posPct = Math.round(((entry - rule.support) / (rule.resistance - rule.support)) * 100);
    if (posPct <= 25) location = `Support (${posPct}%)`;
    else if (posPct >= 75) location = `Resistance (${posPct}%)`;
    else location = `Mid-Chop (${posPct}%)`;
  }

  // Diagnostic reason
  let reason = null;
  if (story === "A") {
    reason = "Clean TP (No Hedge)";
  } else if (story === "W8") {
    reason = "8h Win (Unhedged)";
  } else if (story === "B") {
    reason = direction === "buy" ? "Support Breakdown (Hedged)" : "Resistance Breakout (Hedged)";
  } else if (story === "C") {
    reason = "Hedged Reversal";
  } else if (story === "X") {
    reason = hedged ? "Hedged 8h Close" : "Unhedged 8h Close";
  }

  return { session, location, pos_pct: posPct, reason };
};

