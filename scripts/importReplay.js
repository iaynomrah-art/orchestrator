// Imports a finished replay (.jsonl from replaySignals.js) into replay_signals,
// regrading it with the current rules so it carries everything the dashboard shows.
//
//   node scripts/importReplay.js --file data/replay_candles.jsonl --run v2-candles-6h --m5 data/XAUUSD.r_M5.csv
import "dotenv/config";
import fs from "fs";
import { replayRecord, saveReplay } from "./replayStore.js";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const FILE = arg("file"), RUN = arg("run"), M5 = arg("m5") || "data/XAUUSD.r_M5.csv";
if (!FILE || !RUN) {
  console.error("Usage: node scripts/importReplay.js --file <replay.jsonl> --run <name> [--m5 <M5.csv>]");
  process.exit(1);
}

const lines = fs.readFileSync(M5, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",").map(Number));
const m5 = { time: lines.map((r) => r[0]), open: lines.map((r) => r[1]), high: lines.map((r) => r[2]), low: lines.map((r) => r[3]), close: lines.map((r) => r[4]) };
const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

const rows = fs.readFileSync(FILE, "utf8").trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
const records = rows.map((r) => replayRecord(r, m5, lowerBound(m5.time, r.server_time), RUN));
await saveReplay(records);
console.log(`Imported ${records.length} replay signals as run "${RUN}".`);
process.exit(0);
