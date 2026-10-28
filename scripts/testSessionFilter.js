// Quick comparative test of Session Filters (24/7 vs London/NY vs Asia)
import "dotenv/config";
import { walk } from "../helper/gradeHelper.js";
import { scoreboard, dailyBreakdown } from "../helper/shadowResultsHelper.js";
import { loadCsv, serverToUtcMs, indicatorsAt, lowerBound } from "./replayData.js";

const M5_PATH = "data/XAUUSD.r_M5.csv";
const H1_PATH = "data/XAUUSD.r_H1.csv";
const m5 = loadCsv(M5_PATH);
const h1 = loadCsv(H1_PATH);

const HORIZON_SEC = 8 * 3600;
const STOP_ATR = 1.5;
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const SESSIONS = [
  { name: "All Hours (24/7)", filter: () => true },
  { name: "London & NY (07:00 - 17:00 UTC)", filter: (h) => h >= 7 && h <= 17 },
  { name: "Asia / Off-hours (21:00 - 06:00 UTC)", filter: (h) => h < 7 || h > 17 },
];

const TRIGGERS = [0.10, 0.15, 0.20];

// Test both every 4 hours and every 1 hour
for (const everyHours of [4, 1]) {
  console.log(`\n======================================================================`);
  console.log(`TESTING WITH SIGNALS EVERY ${everyHours} HOUR(S)`);
  console.log(`======================================================================`);

  const rawMoments = [];
  const first = Math.ceil((m5.time[0] + 86400 * 2) / 3600) * 3600;
  for (let t = first + 300; t < m5.time[m5.time.length - 1] - 9 * 3600; t += everyHours * 3600) {
    const hour = Math.floor(t / 3600) % 24;
    if (hour === 23 || hour === 0) continue; // broker rollover
    const i0 = lowerBound(m5.time, t);
    if (i0 >= m5.time.length || m5.time[i0] - t > 600) continue; // market closed
    const micro = indicatorsAt(h1, lowerBound(h1.time, t - 300) - 1);
    if (!micro || !(micro.atr > 0)) continue;
    const utcMs = serverToUtcMs(t);
    const utcHour = new Date(utcMs).getUTCHours();
    rawMoments.push({
      t, i0, slD: STOP_ATR * micro.atr,
      utcHour,
      rating: micro.decision.toLowerCase(),
      coin: rand() < 0.5 ? "buy" : "sell",
    });
  }

  for (const session of SESSIONS) {
    console.log(`\n>>> Session: ${session.name}`);
    const moments = rawMoments.filter((m) => session.filter(m.utcHour));
    console.log(`Total signals: ${moments.length}`);

    for (const trigger of TRIGGERS) {
      const records = moments.map((m) => {
        const row = {
          created_at: new Date(serverToUtcMs(m.t)).toISOString(),
          direction: m.rating,
          tv_direction: m.rating,
          coin_direction: m.coin,
          confidence: null,
          trigger,
          grade: {
            sl_distance: m.slD,
            tp_distance: m.slD,
            entry_price: m5.open[m.i0],
            results: {
              ai: { main: walk(m5, m.i0, m.rating, m.slD, m.slD, trigger, HORIZON_SEC) },
              tv: { main: walk(m5, m.i0, m.rating, m.slD, m.slD, trigger, HORIZON_SEC) },
              coin: { main: walk(m5, m.i0, m.coin, m.slD, m.slD, trigger, HORIZON_SEC) },
            },
          },
        };
        return row;
      });

      const board = scoreboard(records, "main");
      const daily = dailyBreakdown(records, "main");
      const t = board.ai;
      const cleanRate = ((t.a / t.graded) * 100).toFixed(1);
      const perTrade = (t.pnl / t.graded).toFixed(2);
      const zeroDays = daily.one_at_a_time.summary.days_by_tp['0'];
      const totalDays = daily.one_at_a_time.summary.days;
      const zeroPct = ((zeroDays / totalDays) * 100).toFixed(1);
      const pnlPerDay = daily.one_at_a_time.summary.pnl_per_day;

      console.log(
        `  Hedge @ ${Math.round(trigger * 100)}% dip: ` +
        `Clean TP: ${t.a}/${t.graded} (${cleanRate}%) | ` +
        `Unfinished: ${t.x} | ` +
        `0-TP Days: ${zeroDays}/${totalDays} (${zeroPct}%) | ` +
        `Per trade: $${perTrade} | ` +
        `Result/Day: $${pnlPerDay} | ` +
        `Total PnL: $${t.pnl}`
      );
    }
  }
}
