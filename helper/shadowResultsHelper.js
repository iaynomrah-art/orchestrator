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
const CONTRACT = 100;   // XAUUSD: $ per 1.00 move per 1.0 lot
const TRIGGER = 0.1;

/**
 * The trade a signal stands for. With a grade (story), also how it closed:
 *   A  closed at TP, only the primary open             -> +risk
 *   B  hedge opened at the trigger, closed at the SL   -> -10% of risk (pair)
 *   C  hedge opened at the trigger, closed at the TP   -> -10% of risk (pair)
 *   X  still open at 8h: closed at the market price then (markPrice);
 *      locked at -10% if the hedge had opened (mae >= 10% of the SL distance)
 */
export const referenceTrade = (direction, entry, slDistance, story = null, { mae = null, markPrice = null, hedge = null } = {}) => {
  if (!(slDistance > 0) || !(entry > 0)) return null;
  const s = direction === "buy" ? 1 : -1;
  const lot = Math.min(MAX_AUTO_LOT, Math.max(0.01, Math.round((REFERENCE_RISK / (slDistance * CONTRACT)) * 100) / 100));
  const risk = lot * slDistance * CONTRACT;   // $ at the SL (and at the TP, since TP = SL)
  const r2 = (x) => Math.round(x * 100) / 100;
  const sl = entry - s * slDistance, tp = entry + s * slDistance, trigger = entry - s * TRIGGER * slDistance;

  // Two accounts: the primary (signal direction) and the hedge (opposite, same lot),
  // opened at its fill (usually the trigger; worse after a jump) and closed with the primary.
  let close = null, hedged = null;
  if (story === "A") { close = tp; hedged = false; }
  else if (story === "B") { close = sl; hedged = true; }
  else if (story === "C") { close = tp; hedged = true; }
  else if (story === "X") { hedged = (mae != null && mae >= TRIGGER) || !!hedge; if (markPrice > 0) close = markPrice; }
  const fill = hedge?.price > 0 ? hedge.price : trigger;
  const primaryPnl = close === null ? null : (close - entry) * s * lot * CONTRACT;
  const hedgePnl = close === null ? null : hedged ? (close - fill) * -s * lot * CONTRACT : 0;
  const net = primaryPnl === null ? null : primaryPnl + hedgePnl;
  // Slippage: how much worse the hedge opened than planned, as % of the planned loss
  // (planned = the 10% dip; e.g. planned -$10, opened at -$14 -> 40%)
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
    hedge_price: hedged ? r2(fill) : null, hedge_hours: hedge?.hours ?? null,
  };
};

/**
 * The same trade with NORMAL hedging: both accounts open together (same lot,
 * opposite sides, mirrored TP/SL), so whichever way price goes one account wins
 * what the other loses. Main = signal direction, backup = the opposite side.
 */
export const naturalTrade = (direction, entry, slDistance, story, { markPrice = null } = {}) => {
  if (!(slDistance > 0) || !(entry > 0)) return null;
  const s = direction === "buy" ? 1 : -1;
  const lot = Math.min(MAX_AUTO_LOT, Math.max(0.01, Math.round((REFERENCE_RISK / (slDistance * CONTRACT)) * 100) / 100));
  const risk = lot * slDistance * CONTRACT;
  let main = null;
  if (story === "A" || story === "C") main = risk;           // price reached the main's TP
  else if (story === "B") main = -risk;                      // price reached the main's SL
  else if (story === "X" && markPrice > 0) main = (markPrice - entry) * s * lot * CONTRACT;
  if (main === null) return null;
  const r2 = (x) => Math.round(x * 100) / 100;
  return { lot, main: r2(main), backup: r2(-main), net: 0 };
};

/**
 * Delayed hedge vs normal hedge over the same AI trades (finished ones), oldest
 * first: totals per account and a running total for the chart.
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
    if (!g || g.story === "X" || !r.direction) continue;
    const entry = Number(r.grade.entry_price) || Number(r.entry_price), sl = Number(r.grade.sl_distance);
    const d = referenceTrade(r.direction, entry, sl, g.story, { hedge: g.hedge ?? null });
    const n = naturalTrade(r.direction, entry, sl, g.story);
    if (!d || d.pnl === null || !n) continue;
    trades++;
    totals.delayed.net += d.pnl; totals.delayed.main += d.primary_pnl; totals.delayed.backup += d.hedge_pnl;
    if (d.hedged) totals.delayed.backup_used++;
    totals.natural.main += n.main; totals.natural.backup += n.backup;
    totals.natural.backup_used++;
    series.push({ t: r.created_at ?? r.moment, delayed: Math.round(totals.delayed.net * 100) / 100, natural: 0 });
  }
  const r2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { trades, delayed: r2(totals.delayed), natural: r2(totals.natural), series };
};

/** Totals over graded signals for each source: A/B/C/X counts and the $ result at REFERENCE_RISK. */
export const scoreboard = (rows, setting = "t10_tp1") => {
  const out = {};
  for (const src of SOURCES) {
    const t = { graded: 0, a: 0, b: 0, c: 0, x: 0, pnl: 0, slip_sum: 0, slip_n: 0, slip_max: 0 };
    for (const r of rows) {
      const g = r.grade?.results?.[src]?.[setting];
      const dir = src === "ai" ? r.direction : src === "tv" ? r.tv_direction : r.coin_direction;
      if (!g || !dir) continue;
      t.graded++;
      t[g.story.toLowerCase()]++;
      const trade = referenceTrade(dir, Number(r.grade.entry_price) || Number(r.entry_price), Number(r.grade.sl_distance), g.story, { hedge: g.hedge });
      if (trade?.pnl != null) t.pnl += trade.pnl;
      if (trade?.slippage_pct != null) { t.slip_sum += trade.slippage_pct; t.slip_n++; t.slip_max = Math.max(t.slip_max, trade.slippage_pct); }
    }
    const resolved = t.a + t.b + t.c;
    const { slip_sum, slip_n, slip_max, ...rest } = t;
    out[src] = {
      ...rest, resolved, pnl: Math.round(t.pnl * 100) / 100, a_rate: resolved ? Math.round((t.a / resolved) * 1000) / 10 : null,
      hedges: slip_n, slippage_avg_pct: slip_n ? Math.round((slip_sum / slip_n) * 10) / 10 : null, slippage_max_pct: slip_n ? slip_max : null,
    };
  }
  return out;
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
      for (const tally of [buckets[bi].sources[s], overall[s]]) {
        tally.graded++;
        tally[g.story.toLowerCase()]++;
        if (g.story !== "X") tally.resolved++;
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
      tally.graded++;
      tally[g.story.toLowerCase()]++;
      if (g.story !== "X") tally.resolved++;
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
