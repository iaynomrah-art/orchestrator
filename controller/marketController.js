import { BadRequestError } from "../errors/index.js";
import { supabase } from "../config/supabase.js";
import {
  getExchangeConfig,
  fetchTechnicalData,
  TIMEFRAME_MAP,
} from "../helper/marketHelper.js";
import { summarizeGrades, scoreboard, referenceTrade, naturalTrade, strategyComparison, dailyBreakdown, luckTest, sizingOf, gradeOpts, tradingCost, REFERENCE_RISK, MAX_AUTO_LOT, getTradeDiagnostic } from "../helper/shadowResultsHelper.js";
import { getVolatility } from "../helper/marketContextHelper.js";
import { loadCandles } from "../helper/candleRecorder.js";
import { refreshTradingCost } from "../helper/tradingCostHelper.js";
import { getTradeCandles } from "../helper/tradeChartHelper.js";
import fs from "fs";

/**
 * Get market signal forecast for a symbol and timeframe
 * @route GET /api/v1/market/forecast
 */
export const getMarketForecast = async (req, res, next) => {
  try {
    const { response } = await generateSignal({
      symbol: req.query.symbol || "XAUUSD",
      timeframe: req.query.timeframe || "1h",
    });
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * SL distance for a ~4-8h trade, for sizing lots (lots = SL $ / (distance x contract)).
 * From the MT5 volatility numbers when fresh, else 1.5x the 1h ATR (the AI's own stop).
 * No AI call, so it's instant.
 * @route GET /api/v1/market/volatility?symbol=XAUUSD
 */
export const getSizingVolatility = async (req, res, next) => {
  try {
    const targetSymbol = (req.query.symbol || "XAUUSD").toUpperCase();
    const vol = await getVolatility(targetSymbol);
    if (vol?.suggested_sl_distance) {
      return res.status(200).json({
        symbol: targetSymbol,
        source: "mt5",
        sl_distance: Number(vol.suggested_sl_distance),
        forecast_6h: Number(vol.forecast_6h),
        computed_at: vol.computed_at,
      });
    }
    const microData = await fetchTechnicalData(getExchangeConfig(targetSymbol), TIMEFRAME_MAP["1h"]);
    res.status(200).json({
      symbol: targetSymbol,
      source: "atr",
      sl_distance: Math.round(1.5 * microData.atr * 100) / 100,
      forecast_6h: null,
      computed_at: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Everything the Prediction Monitor page shows, in one call: whether shadow mode
 * runs, price recording and volatility freshness, the latest signals with their
 * outcomes, and the historical replay summary (data/replay_150.jsonl) if present.
 * @route GET /api/v1/market/shadow-status
 */
export const getShadowStatus = async (req, res, next) => {
  try {
    await refreshTradingCost();
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();
    const [vol, lastCandle, candlesHour, signals, totals, graded] = await Promise.all([
      supabase.from("market_volatility").select("computed_at, forecast_6h, ratio_now, source").eq("symbol", "XAUUSD").maybeSingle(),
      supabase.from("market_candles").select("minute, close, ticks").eq("symbol", "XAUUSD").order("minute", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("market_candles").select("minute", { count: "exact", head: true }).eq("symbol", "XAUUSD").gte("minute", hourAgo),
      supabase.from("market_signals")
        .select("id, created_at, shadow, direction, tv_direction, coin_direction, confidence, score_v2, entry_price, stop_price, target_price, graded_at, grade, inputs")
        .eq("shadow", true).order("created_at", { ascending: false }).limit(48),
      supabase.from("market_signals").select("id", { count: "exact", head: true }).eq("shadow", true),
      supabase.from("market_signals").select("id", { count: "exact", head: true }).eq("shadow", true).not("graded_at", "is", null),
    ]);

    // Scoreboard over every graded shadow signal (paged; a few hundred rows)
    const gradedRows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("market_signals")
        .select("created_at, direction, tv_direction, coin_direction, entry_price, grade, inputs")
        .eq("shadow", true).not("graded_at", "is", null).range(from, from + 999);
      if (error) throw new BadRequestError(error.message);
      gradedRows.push(...data.map((r) => ({ ...r, rule: r.inputs?.rule ?? null })));
      if (data.length < 1000) break;
    }

    // Signals from the S/R rule are graded held until SL/TP ("main"): once there are any, the
    // scoreboard counts only those, and only the ones the rule sent to the delayed hedge
    const ruleGraded = (r) => !!r.grade?.results?.ai?.main;
    const ruleMode = gradedRows.some(ruleGraded);
    const setting = ruleMode ? "main" : "t10_tp1";
    const boardRows = ruleMode ? gradedRows.filter((r) => ruleGraded(r) && r.rule?.passed) : gradedRows;

    const settingOf = (g) => (g?.results?.ai?.main ? "main" : "t10_tp1");
    const outcome = (g, src) => g?.results?.[src]?.[settingOf(g)]?.story ?? null;
    const slDistance = (s) => Number(s.grade?.sl_distance) || Math.abs(Number(s.entry_price) - Number(s.stop_price));
    // Grades are measured from the first recorded price at signal time when there is one
    const entryOf = (s) => Number(s.grade?.entry_price) || Number(s.entry_price);

    // Unfinished trades close at the market price at the 8-hour mark
    const markPrices = {};
    await Promise.all((signals.data || []).filter((s) => outcome(s.grade, "ai") === "X").map(async (s) => {
      const end = new Date(new Date(s.created_at).getTime() + 8 * 3600 * 1000);
      const { data } = await supabase.from("market_candles").select("close").eq("symbol", "XAUUSD")
        .lte("minute", end.toISOString()).gte("minute", new Date(end.getTime() - 3 * 3600 * 1000).toISOString())
        .order("minute", { ascending: false }).limit(1).maybeSingle();
      if (data) markPrices[s.id] = Number(data.close);
    }));
    const nextRun = new Date(now);
    nextRun.setUTCMinutes(5, 0, 0);
    if (nextRun <= now) nextRun.setUTCHours(nextRun.getUTCHours() + 1);

    let replay = null;
    try {
      const fs = await import("fs");
      const path = new URL("../data/replay_150.jsonl", import.meta.url);
      if (fs.existsSync(path)) {
        const rows = fs.readFileSync(path, "utf8").trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
        const pick = (s) => ({ ai: s.overall.ai.a_rate, tv: s.overall.tv.a_rate, coin: s.overall.coin.a_rate, luck: s.luck_a_rate, resolved: s.overall.ai.resolved });
        replay = {
          signals: rows.length,
          agree_pct: Math.round((rows.filter((r) => r.direction === r.tv_direction).length / rows.length) * 100),
          t10: pick(summarizeGrades(rows, "t10_tp1")),
          t15: pick(summarizeGrades(rows, "t15_tp1")),
          from: rows[0]?.created_at, to: rows[rows.length - 1]?.created_at,
        };
      }
    } catch (error) {
      console.warn(`[market] Replay summary unavailable: ${error.message}`);
    }

    res.status(200).json({
      now: now.toISOString(),
      shadow_enabled: process.env.SHADOW_SIGNALS_ENABLED === "true",
      next_shadow_run: nextRun.toISOString(),
      volatility: vol.data ?? null,
      candles: { last: lastCandle.data ?? null, last_hour: candlesHour.count ?? 0 },
      counts: { shadow: totals.count ?? 0, graded: graded.count ?? 0 },
      reference: ruleMode
        ? { risk: REFERENCE_RISK, max_lot: MAX_AUTO_LOT, trigger_pct: 10, cost: tradingCost(), rule_mode: true,
            lot: Number(boardRows[0]?.rule?.lot) || 0.03, tp: "TP = S/R range (at least $5)",
            hold: "held until SL or TP (up to 15 days), overnight swap included; only signals the rule sent to the delayed hedge" }
        : { risk: REFERENCE_RISK, max_lot: MAX_AUTO_LOT, trigger_pct: 10, tp: "TP = SL distance", cost: tradingCost() },
      scoreboard: scoreboard(boardRows, setting),
      comparison: strategyComparison(boardRows, setting),
      daily: dailyBreakdown(boardRows, setting),
      signals: (signals.data || []).map((s) => {
        const outAi = outcome(s.grade, "ai");
        const entry = entryOf(s);
        const slD = slDistance(s);
        const rowSetting = settingOf(s.grade);
        const sRow = { ...s, rule: s.inputs?.rule ?? null };
        const gAi = s.grade?.results?.ai?.[rowSetting];
        const trade = rowSetting === "main" && gAi
          ? referenceTrade(s.direction, entry, slD, outAi, gradeOpts(sRow, gAi, "main"))
          : referenceTrade(s.direction, entry, slD, outAi, {
            mae: s.grade?.results?.ai?.t10_tp1?.mae ?? null, markPrice: markPrices[s.id] ?? null,
            hedge: s.grade?.results?.ai?.t10_tp1?.hedge ?? null,
          });
        const rule = s.inputs?.rule ?? s.inputs?.support_resistance?.h24 ?? s.inputs?.support_resistance?.h8 ?? null;
        return {
          id: s.id, created_at: s.created_at, shadow: s.shadow, entry_price: s.entry_price,
          ai: s.direction, tv: s.tv_direction, coin: s.coin_direction, score: s.confidence, score_v2: s.score_v2,
          graded_at: s.graded_at, skipped: s.grade?.skipped ?? null,
          outcome: { ai: outAi, tv: outcome(s.grade, "tv"), coin: outcome(s.grade, "coin") },
          hours: s.grade?.results?.ai?.[rowSetting]?.hours ?? (outAi === "X" ? 8 : null),
          trade,
          rule,
          // The rule's decision for this signal: delayed hedge, or normal hedge and why
          hedge_mode: s.inputs?.rule?.passed === true ? "delayed" : s.inputs?.rule?.passed === false ? "normal" : null,
          skip_reason: s.inputs?.rule?.skip_reason ?? null,
          natural: rowSetting === "main"
            ? naturalTrade(s.direction, entry, slD, outAi, { markPrice: Number(s.grade?.mark_price) || null, swap: gAi?.swap ?? null, ...sizingOf(sRow, "main") })
            : naturalTrade(s.direction, entry, slD, outAi, { markPrice: markPrices[s.id] ?? null }),
          // Same trade had the rating / coin flip picked the direction: net $ of the pair
          compare: Object.fromEntries(["tv", "coin"].map((src) => {
            const g = s.grade?.results?.[src]?.[rowSetting];
            const dir = src === "tv" ? s.tv_direction : s.coin_direction;
            const t = g && dir && g.story !== "X"
              ? referenceTrade(dir, entry, slD, g.story, rowSetting === "main" ? gradeOpts(sRow, g, "main") : { hedge: g.hedge ?? null })
              : null;
            return [src, t?.pnl ?? null];
          })),
          diagnostic: getTradeDiagnostic({ time: s.created_at, entry, rule, story: outAi, hedged: trade?.hedged ?? false, direction: s.direction }),
        };
      }),
      replay,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Past-data test: signals made for past moments (only what was known then), graded
 * on what followed. Same scoreboard and trade rows as the live view, plus a
 * side-by-side summary of every run (the AI prompts and the rule-based approaches).
 * Rule runs also hold the moments the rule skipped (rule.passed = false): they are
 * left out of the trades and summarised separately.
 * @route GET /api/v1/market/replay?run=v2-candles-6h
 */
const REPLAY_CACHE_MS = 60 * 1000;
const FEATURED_RUN = "sr-bounce-40-9am-8pm";
const TRADE_LOG_LIMIT = 400;
let replayCache = { at: 0, rows: null, loading: null };

// Answers from the cache straight away; once it is older than REPLAY_CACHE_MS it is
// refreshed in the background, so only the very first visit waits for the download.
const loadReplayRows = async (force = false) => {
  if (!force && replayCache.rows && Date.now() - replayCache.at < REPLAY_CACHE_MS) return replayCache.rows;
  if (!replayCache.loading || force) {
    replayCache.loading = fetchReplayRows()
      .then((rows) => { replayCache = { at: Date.now(), rows, loading: null }; return rows; })
      .catch((error) => { replayCache.loading = null; throw error; });
  }
  if (replayCache.rows && !force) {
    replayCache.loading.catch((error) => console.warn(`[market] Replay refresh failed (showing the last results): ${error.message}`));
    return replayCache.rows;
  }
  return replayCache.loading;
};

// Fill the cache a minute after start-up, so the first visit after a deploy doesn't wait either
setTimeout(() => loadReplayRows().catch((error) => console.warn(`[market] Replay cache warm-up failed: ${error.message}`)), 60 * 1000).unref();

const fetchReplayRows = async () => {
  // Only the grade the page uses, not every setting: a much smaller download. That is the
  // run's own setting ("main": its trigger, TP = SL) when it has one, else 10% / TP = SL.
  // Paged by position (moment, id), not offset, so rows a running replay adds can't shift pages.
  const all = [];
  for (let last = null; ;) {
    let query = supabase.from("replay_signals")
      .select("id, run, moment, direction, tv_direction, coin_direction, confidence, entry_price, "
        + "g_entry:grade->entry_price, g_sl:grade->sl_distance, g_tp:grade->tp_distance, g_mark:grade->mark_price, "
        + "g_ai:grade->results->ai->t10_tp1, g_tv:grade->results->tv->t10_tp1, g_coin:grade->results->coin->t10_tp1, "
        + "m_ai:grade->results->ai->main, m_tv:grade->results->tv->main, m_coin:grade->results->coin->main, m_opp:grade->results->opp->main, "
        + "picker:inputs->>picker, trigger:inputs->trigger, rule:inputs->rule")
      .order("moment", { ascending: false }).order("id").limit(1000);
    if (last) query = query.or(`moment.lt.${last.moment},and(moment.eq.${last.moment},id.gt.${last.id})`);
    const { data, error } = await query;
    if (error) throw new BadRequestError(`Could not read replay signals: ${error.message}`);
    if (data.length) last = { moment: new Date(data[data.length - 1].moment).toISOString(), id: data[data.length - 1].id };
    all.push(...data.map(({ g_entry, g_sl, g_tp, g_mark, g_ai, g_tv, g_coin, m_ai, m_tv, m_coin, m_opp, ...r }) => ({
      ...r,
      trigger: Number(r.trigger) || 0.1,
      grade: {
        // Runs graded at their own TP have a "main" grade; the AI runs fall back to t10_tp1 (TP = SL)
        entry_price: g_entry, sl_distance: g_sl, tp_distance: m_ai ? g_tp : g_sl, mark_price: g_mark,
        results: Object.fromEntries([["ai", m_ai ?? g_ai], ["tv", m_tv ?? g_tv], ["coin", m_coin ?? g_coin], ["opp", m_opp]].filter(([, g]) => g).map(([k, g]) => [k, { main: g }])),
      },
    })));
    if (data.length < 1000) break;
  }
  return all;
};

/** One run's headline numbers for the approach comparison. */
const approachSummary = (run, rows) => {
  const taken = rows.filter((r) => r.rule?.passed !== false);
  const skipped = rows.filter((r) => r.rule?.passed === false);
  const board = scoreboard(taken, "main"), cmp = strategyComparison(taken, "main"), daily = dailyBreakdown(taken, "main");
  const perTrade = (v, n) => (n ? Math.round((v / n) * 100) / 100 : null);
  const pick = (t) => ({ graded: t.graded, a: t.a, b: t.b, c: t.c, x: t.x, resolved: t.resolved, a_rate: t.a_rate, a_rate_all: t.a_rate_all });
  const rule = rows.find((r) => r.rule)?.rule ?? null;
  const sl = taken.map((r) => Number(r.grade?.sl_distance)).filter((v) => v > 0);
  let skippedSummary = null;
  if (skipped.length) {
    const sb = scoreboard(skipped, "main").ai, sc = strategyComparison(skipped, "main");
    skippedSummary = { moments: skipped.length, ...pick(sb), delayed_per_trade: perTrade(sc.delayed.net, sc.trades) };
  }
  return {
    run, picker: rows[0]?.picker ?? "ai", trigger: rows[0]?.trigger ?? 0.1,
    rule: rule && { name: rule.name, f: rule.f, target: rule.target, lot: rule.lot, budget: rule.budget, sl_distance: rule.sl_distance, stop: rule.stop },
    moments: rows.length, trades: taken.length,
    from: rows[rows.length - 1]?.moment, to: rows[0]?.moment,
    avg_sl: sl.length ? Math.round((sl.reduce((x, y) => x + y, 0) / sl.length) * 100) / 100 : null,
    main: pick(board.ai), coin: pick(board.coin),
    delayed_per_trade: perTrade(cmp.delayed.net, cmp.trades), natural_per_trade: perTrade(cmp.natural.net, cmp.trades),
    delayed_total: cmp.delayed.net, natural_total: cmp.natural.net, priced_trades: cmp.trades,
    skipped: skippedSummary,
    luck: luckTest(taken, "main"),
    per_day: { every: daily.every.summary, one_at_a_time: daily.one_at_a_time.summary },
  };
};

export const getReplayResults = async (req, res, next) => {
  try {
    await refreshTradingCost();
    const all = await loadReplayRows(req.query.fresh === "true" || req.query.fresh === "1");
    const byRun = new Map();
    for (const r of all) { if (!byRun.has(r.run)) byRun.set(r.run, []); byRun.get(r.run).push(r); }
    const approaches = [...byRun].map(([run, rows]) => approachSummary(run, rows));
    const runs = approaches.map((a) => ({ run: a.run, signals: a.trades, from: a.from, to: a.to }));
    // The run being considered for live (fewer, stronger delayed trades) opens first
    const defaultRun = byRun.has(FEATURED_RUN) ? FEATURED_RUN : byRun.has("sr-tv-30d") ? "sr-tv-30d" : (byRun.has("sr-adaptive") ? "sr-adaptive" : (byRun.has("sr-tv-combined") ? "sr-tv-combined" : (byRun.has("sr-budget-12") ? "sr-budget-12" : (byRun.has("sr-budget-15") ? "sr-budget-15" : (runs[runs.length - 1]?.run ?? null)))));
    const run = byRun.has(req.query.run) ? req.query.run : defaultRun;
    const rows = (byRun.get(run) ?? []).filter((r) => r.rule?.passed !== false);

    const story = (r, src) => r.grade?.results?.[src]?.main?.story ?? null;
    const tradeFor = (r, src, dir) => {
      const g = r.grade?.results?.[src]?.main;
      return g ? referenceTrade(dir, Number(r.grade.entry_price) || Number(r.entry_price), Number(r.grade.sl_distance), g.story, gradeOpts(r, g, "main")) : null;
    };
    const trigger = rows[0]?.trigger ?? 0.1;
    res.status(200).json({
      runs, run, approaches,
      picker: rows[0]?.picker ?? "ai",
      reference: {
        risk: REFERENCE_RISK, max_lot: MAX_AUTO_LOT, trigger_pct: Math.round(trigger * 100), cost: tradingCost(),
        lot: Number(rows[0]?.rule?.lot) || null,
        tp: rows[0]?.rule?.lot ? "TP = S/R range (at least $5)" : "TP = SL distance",
        hold: rows[0]?.rule?.hold_days ? `held until SL or TP (up to ${rows[0].rule.hold_days} days), overnight swap included, one pair at a time` : "closed at 8 hours if unfinished",
      },
      scoreboard: scoreboard(rows, "main"),
      comparison: strategyComparison(rows, "main"),
      daily: dailyBreakdown(rows, "main"),
      signals: rows.slice(0, TRADE_LOG_LIMIT).map((r) => {
        const trade = tradeFor(r, "ai", r.direction);
        let storyAi = story(r, "ai");
        if (storyAi === "X") {
          storyAi = (trade?.pnl ?? 0) >= 0 ? (trade?.hedged ? "C" : "W8") : "B";
        }
        let tradeTv = tradeFor(r, "tv", r.tv_direction);
        let storyTv = story(r, "tv");
        if (storyTv === "X") {
          storyTv = (tradeTv?.pnl ?? 0) >= 0 ? (tradeTv?.hedged ? "C" : "W8") : "B";
        }
        let tradeCoin = tradeFor(r, "coin", r.coin_direction);
        let storyCoin = story(r, "coin");
        if (storyCoin === "X") {
          storyCoin = (tradeCoin?.pnl ?? 0) >= 0 ? (tradeCoin?.hedged ? "C" : "W8") : "B";
        }
        const entry = Number(r.grade?.entry_price) || Number(r.entry_price);
        return {
          id: r.id, created_at: r.moment, shadow: true, entry_price: r.entry_price,
          ai: r.direction, tv: r.tv_direction, coin: r.coin_direction, score: r.confidence, graded_at: r.moment, skipped: null,
          outcome: { ai: storyAi, tv: storyTv, coin: storyCoin },
          hours: r.grade?.results?.ai?.main?.hours ?? 8,
          trade,
          natural: naturalTrade(r.direction, entry, Number(r.grade?.sl_distance), storyAi,
            { markPrice: Number(r.grade?.mark_price) || null, swap: r.grade?.results?.ai?.main?.swap ?? null, ...sizingOf(r, "main") }),
          compare: { tv: tradeFor(r, "tv", r.tv_direction)?.pnl ?? null, coin: tradeFor(r, "coin", r.coin_direction)?.pnl ?? null },
          rule: r.rule?.range != null ? {
            support: r.rule.support, resistance: r.rule.resistance, range: r.rule.range,
            window_hours: r.rule.window_hours, pump_dump: r.rule.pump_dump,
            proximity_pct: r.rule.proximity_pct, is_near_boundary: r.rule.is_near_boundary,
            past_trend: r.rule.past_trend, past_score: r.rule.past_score, past_counter_trend: r.rule.past_counter_trend,
            trigger_price: r.rule.trigger_price,
            us_news_at: r.rule.us_news_at ?? null,
          } : null,
          diagnostic: getTradeDiagnostic({ time: r.moment, entry, rule: r.rule, story: storyAi, hedged: trade?.hedged ?? false, direction: r.direction }),
        };
      }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Recorded gold candles for the monitor chart (grouped to `tf` minutes), plus the
 * shadow signals in that window with their entry, SL, TP and outcome.
 * @route GET /api/v1/market/candles?hours=12&tf=5
 */
export const getChartCandles = async (req, res, next) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 12, 1), 48);
    const tf = [1, 5, 15].includes(Number(req.query.tf)) ? Number(req.query.tf) : 5;
    const now = Date.now();
    const from = now - hours * 3600 * 1000;
    const [rows, signals] = await Promise.all([
      loadCandles("XAUUSD", from, now),
      supabase.from("market_signals")
        .select("id, created_at, direction, confidence, entry_price, stop_price, target_price, grade")
        .eq("shadow", true).gte("created_at", new Date(from).toISOString()).order("created_at"),
    ]);
    if (signals.error) throw new BadRequestError(signals.error.message);

    const bars = [];
    for (const c of rows) {
      const t = Math.floor(c.minute / (tf * 60000)) * tf * 60;   // bar start, epoch seconds
      const last = bars[bars.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close;
      } else {
        bars.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
      }
    }
    res.status(200).json({
      symbol: "XAUUSD", tf, hours,
      candles: bars,
      signals: signals.data.map((s) => ({
        id: s.id, time: Math.floor(new Date(s.created_at).getTime() / 1000), direction: s.direction, score: s.confidence,
        entry: s.entry_price, stop: s.stop_price, target: s.target_price,
        outcome: s.grade?.results?.ai?.t10_tp1?.story ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * How graded signals did, per score range: AI vs TradingView rating vs coin flip
 * @route GET /api/v1/market/shadow-results?days=30&setting=t10_tp1&score=v1&shadow=all
 */
export const getShadowResults = async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    const setting = /^t(10|15)_(tp1|tpai)$/.test(req.query.setting) ? req.query.setting : "t10_tp1";
    const scoreVersion = req.query.score === "v2" ? "v2" : "v1";
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const rows = [];
    for (let from = 0; ; from += 1000) {
      let query = supabase
        .from("market_signals")
        .select("created_at, shadow, direction, tv_direction, coin_direction, confidence, score_v2, grade, sr:inputs->support_resistance")
        .not("graded_at", "is", null)
        .gte("created_at", since)
        .order("created_at")
        .range(from, from + 999);
      if (req.query.shadow === "only") query = query.eq("shadow", true);
      const { data, error } = await query;
      if (error) throw new BadRequestError(`Could not read graded signals: ${error.message}`);
      rows.push(...data);
      if (data.length < 1000) break;
    }

    res.status(200).json({ days, ...summarizeGrades(rows, setting, scoreVersion) });
  } catch (error) {
    next(error);
  }
};

/**
 * Get just the current price for a symbol — cheap, no Ollama call, safe to
 * poll frequently for a live-feeling price display (unlike /forecast, which
 * can take up to 60s because of the LLM call).
 * @route GET /api/v1/market/price
 */
export const getCurrentPrice = async (req, res, next) => {
  try {
    const symbol = req.query.symbol || "XAUUSD";
    const targetSymbol = symbol.toUpperCase();
    const config = getExchangeConfig(targetSymbol);
    const microTfData = TIMEFRAME_MAP["5m"] || TIMEFRAME_MAP["1h"];

    const data = await fetchTechnicalData(config, microTfData);

    res.status(200).json({
      symbol: targetSymbol,
      price: data.price,
      timestamp: Date.now(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get market support and resistance levels for a symbol and timeframe
 * @route GET /api/v1/market/levels
 */
export const getSupportResistance = async (req, res, next) => {
  try {
    const symbol = req.query.symbol || "XAUUSD";
    const timeframe = req.query.timeframe || "1h";

    const targetSymbol = symbol.toUpperCase();
    const config = getExchangeConfig(targetSymbol);
    
    const microTfKey = timeframe.toLowerCase();
    const microTfData = TIMEFRAME_MAP[microTfKey] || TIMEFRAME_MAP["1h"];

    const microData = await fetchTechnicalData(config, microTfData);
        
    res.status(200).json({
      support1: microData.support1,
      support2: microData.support2,
      resistance1: microData.resistance1,
      resistance2: microData.resistance2
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Market timing statistics measured from the broker's 5-minute candles
 * (scripts/timingStats.js writes the file).
 * @route GET /api/v1/market/timing
 */
export const getMarketTiming = async (req, res, next) => {
  try {
    const file = new URL("../stats/timing_stats.json", import.meta.url);
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: "No timing statistics yet: run node scripts/timingStats.js --m5 <M5.csv>" });
    }
    res.status(200).json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    next(error);
  }
};

/**
 * Visual trade chart candles: returns 5m candles surrounding a trade's open time
 * @route GET /api/v1/market/trade-chart?time=2026-03-12T01:05:00.000Z&before=4&after=10
 */
export const getTradeChart = async (req, res, next) => {
  try {
    const time = req.query.time;
    if (!time) throw new BadRequestError("Trade time query parameter is required");
    const beforeHours = Math.min(Math.max(Number(req.query.before) || 4, 1), 24);
    const afterHours = Math.min(Math.max(Number(req.query.after) || 10, 1), 48);

    const data = await getTradeCandles(time, { beforeHours, afterHours });
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};