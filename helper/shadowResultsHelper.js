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

  return {
    setting,
    score_version: scoreVersion,
    luck_a_rate: luck,
    signals: graded.length,
    overall: Object.fromEntries(SOURCES.map((s) => [s, finish(overall[s])])),
    buckets: buckets.map((b) => ({ label: b.label, sources: Object.fromEntries(SOURCES.map((s) => [s, finish(b.sources[s])])) })),
  };
};
