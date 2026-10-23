// One-time: regrades already graded shadow signals from the recorded 1-minute
// candles, so older grades get fields added to the grader later (e.g. the hedge's
// fill price and time). Same rules and candles, so outcomes don't change.
//
//   node scripts/regradeSignals.js            (dry run: prints what would change)
//   node scripts/regradeSignals.js --write    (saves the new grades)
import "dotenv/config";
import { supabase } from "../config/supabase.js";
import { gradeSignal } from "../cron/gradeSignals.js";

const WRITE = process.argv.includes("--write");
const { data: rows, error } = await supabase.from("market_signals")
  .select("id, created_at, direction, tv_direction, coin_direction, entry_price, stop_price, target_price, grade")
  .eq("shadow", true).not("graded_at", "is", null).order("created_at");
if (error) throw new Error(error.message);

let updated = 0, changedStory = 0, skipped = 0;
for (const sig of rows) {
  const grade = await gradeSignal("XAUUSD", sig);
  if (!grade || grade.skipped || !grade.results) { skipped++; continue; }   // no recorded candles for it
  const before = sig.grade?.results?.ai?.t10_tp1?.story, after = grade.results.ai?.t10_tp1?.story;
  if (before && before !== after) changedStory++;
  const h = grade.results.ai?.t10_tp1?.hedge;
  console.log(`${sig.created_at.slice(0, 16)} ${sig.direction} ${before} -> ${after}${h ? `  hedge filled ${h.price} after ${h.hours}h` : ""}`);
  if (WRITE) {
    const { error: e } = await supabase.from("market_signals").update({ grade }).eq("id", sig.id);
    if (e) console.error(`  failed: ${e.message}`); else updated++;
  }
}
console.log(`\n${rows.length} graded shadow signals: ${WRITE ? `${updated} updated` : "dry run"}, ${skipped} skipped (no candles), ${changedStory} outcome changes`);
process.exit(0);
