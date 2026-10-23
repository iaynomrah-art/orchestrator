// Saves past-data (replay) signals to the replay_signals table, so the
// dashboard's "Past data" view can show them like the live test.
import { supabase } from "../config/supabase.js";
import { gradeAll } from "../helper/gradeHelper.js";

const HORIZON_SEC = 8 * 3600;

/** Market price at the 8-hour mark (for trades that hadn't finished by then). */
const markPrice = (m5, i0) => {
  const end = m5.time[i0] + HORIZON_SEC;
  let j = i0;
  while (j + 1 < m5.time.length && m5.time[j + 1] < end) j++;
  return m5.close[j];
};

/** A replay_signals row from a replay result, graded with the current rules on broker 5-minute candles. */
export const replayRecord = (row, m5, i0, run) => {
  const slD = row.grade.sl_distance, tpD = row.grade.tp_distance;
  const dirs = { ai: row.direction, tv: row.tv_direction, coin: row.coin_direction };
  return {
    run,
    moment: row.created_at,
    direction: row.direction, tv_direction: row.tv_direction, coin_direction: row.coin_direction,
    confidence: row.confidence,
    entry_price: m5.open[i0],
    sl_distance: slD, tp_distance: tpD,
    grade: {
      version: 1, grader: "replay-mt5-5m", horizon_h: 8,
      entry_price: m5.open[i0], mark_price: markPrice(m5, i0), sl_distance: slD, tp_distance: tpD,
      results: gradeAll(m5, i0, dirs, slD, tpD, HORIZON_SEC),
    },
    inputs: { prompt: row.prompt ?? "v1", candle_lines: row.candle_lines ?? [], news_impact: row.news_impact ?? null },
  };
};

export const saveReplay = async (records) => {
  for (let i = 0; i < records.length; i += 200) {
    const { error } = await supabase.from("replay_signals").upsert(records.slice(i, i + 200), { onConflict: "run,moment" });
    if (error) throw new Error(`Could not save replay signals: ${error.message}`);
  }
};
