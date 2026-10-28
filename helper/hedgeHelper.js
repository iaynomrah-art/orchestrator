// Delayed hedge planning: decides at pairing time whether a pair runs the
// delayed hedge (primary alone, secondary on standby) or the natural hedge
// (both legs together), and sizes the hedge leg.

// Default trigger, as a fraction of the primary's SL distance. A signal from the S/R rule
// carries its own (inputs.trigger: $0.50 past the S/R level, capped at a $20 loss).
export const HEDGE_TRIGGER_PCT = 0.10;
// Hedge lot = primary lot. Both outcomes once hedged cost the trigger loss (10% of SL):
// at the primary's SL the hedge has made 90% of it back, and on a reversal to the
// primary's TP the hedge loses the TP distance plus the trigger gap. A bigger lot
// (1.11) would make the SL side break even but double the reversal loss.
export const HEDGE_MULTIPLIER = 1;

const natural = (reason) => ({ strategy: "natural", reason });

/**
 * @param {object} p
 * @param {boolean} p.enabled          DELAYED_HEDGE_ENABLED
 * @param {number}  p.minScore         lowest signal score that may use the delayed hedge
 * @param {object|null} p.signal       linked market_signals row ({ confidence, source })
 * @param {string[]} p.events          [p1Event, p2Event]
 * @param {string[]} p.operations      [p1 operation, p2 operation] (staging ops)
 * @param {object}  p.primary          { order_amount, stop_loss, take_profit, sl_type, tp_type } — $ amounts
 * @param {number|null} p.primarySafeLimit   max $ the primary account can risk
 * @param {number|null} p.secondarySafeLimit max $ the secondary account can risk
 * @param {boolean} [p.testMode]       skip the signal checks (demo testing only)
 */
export const planDelayedHedge = ({ enabled, minScore, signal, events, operations, primary, primarySafeLimit, secondarySafeLimit, testMode = false }) => {
  if (!enabled) return natural("Delayed hedge is turned off");
  const score = Number(signal?.confidence);
  if (!testMode) {
    if (!signal) return natural("No AI signal linked to this pair");
    if (signal.source !== "ai" && signal.source !== "sr-tv-synergy" && signal.source !== "sr-tv-combined") return natural("Signal came from an untrusted fallback, not the validated model");
    if (!Number.isFinite(score) || score < minScore) return natural(`Signal score ${signal.confidence ?? "n/a"} is below ${minScore}`);
    // News or rollover at signal time: stop orders slip and whipsaws are likelier
    const blocks = signal.inputs?.hedge_block;
    if (Array.isArray(blocks) && blocks.length) return natural(`Delayed hedge blocked: ${blocks.join("; ")}`);
  }

  // MT5 GUI only for now
  const mt5Gui = events.every((e) => e === "run_metatrader5") && operations.every((o) => String(o || "").endsWith("-gui"));
  if (!mt5Gui) return natural("Delayed hedge only runs on MT5 GUI accounts for now");

  if (primary.sl_type !== "dollar" || primary.tp_type !== "dollar") return natural("Primary SL/TP must be in dollar mode");

  const lot = Number(primary.order_amount);
  const sl = Number(primary.stop_loss);
  const tp = Number(primary.take_profit);
  if (!(lot > 0 && sl > 0 && tp > 0)) return natural("Primary lot, SL and TP must all be set");

  const signalTrigger = Number(signal?.inputs?.trigger);
  const triggerPct = !testMode && signalTrigger > 0 && signalTrigger < 1 ? signalTrigger : HEDGE_TRIGGER_PCT;

  const hedgeLot = Math.round(lot * HEDGE_MULTIPLIER * 100) / 100;
  const scale = hedgeLot / lot;
  // Hedge opens at -trigger; its SL sits at the primary's TP and its TP at the primary's SL
  const hedgeRisk = Math.round(scale * (tp + triggerPct * sl) * 100) / 100;
  const hedgeReward = Math.round(scale * (1 - triggerPct) * sl * 100) / 100;

  const fits = (limit, need) => Number.isFinite(Number(limit)) && Number(limit) >= need;
  let swap = false;
  if (!fits(secondarySafeLimit, hedgeRisk)) {
    // The hedge leg carries the bigger worst case, so it goes on the account with more room
    if (fits(primarySafeLimit, hedgeRisk) && fits(secondarySafeLimit, sl)) {
      swap = true;
    } else {
      return natural(`Neither account has room for the hedge's worst case ($${hedgeRisk})`);
    }
  }

  return {
    strategy: "delayed_hedge",
    reason: testMode ? "Test mode: AI score check skipped" : `Signal score ${score}`,
    swap,
    trigger_pct: triggerPct,
    hedge: { order_amount: hedgeLot, stop_loss: hedgeRisk, take_profit: hedgeReward },
  };
};
