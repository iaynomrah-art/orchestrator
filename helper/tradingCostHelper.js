// Measures what trading really costs per account, from the finished normal-hedge
// pairs in paired_trading_accounts: with both legs closed, main + backup would be
// $0 without costs, so what's left (spread, commission, the backup's wider SL /
// smaller TP) divided by the lots is the cost. Refreshed hourly; feeds setTradingCost.
import { supabase } from "../config/supabase.js";
import { setTradingCost } from "./shadowResultsHelper.js";

const REFRESH_MS = 3600 * 1000;
let measuredAt = 0;

export const refreshTradingCost = async () => {
  if (Date.now() - measuredAt < REFRESH_MS) return;
  measuredAt = Date.now();
  try {
    const { data, error } = await supabase.from("paired_trading_accounts")
      .select("strategy, primary_order_amount, primary_starting_balance, primary_final_balance, secondary_starting_balance, secondary_final_balance")
      .eq("trade_status", "done").limit(1000);
    if (error) throw new Error(error.message);
    const pairs = data.filter((r) => r.strategy !== "delayed_hedge"
      && [r.primary_starting_balance, r.primary_final_balance, r.secondary_starting_balance, r.secondary_final_balance, r.primary_order_amount].every((v) => Number(v) > 0))
      .map((r) => ({ lot: Number(r.primary_order_amount), main: r.primary_final_balance - r.primary_starting_balance, backup: r.secondary_final_balance - r.secondary_starting_balance }))
      // both legs closed: one won, one lost
      .filter((x) => Math.abs(x.main) > 1 && Math.abs(x.backup) > 1 && Math.sign(x.main) !== Math.sign(x.backup));
    if (!pairs.length) return;
    // Per account per 1.0 lot: the pair's shortfall split over its two accounts
    const perLot = pairs.reduce((sum, x) => sum + (-(x.main + x.backup) / x.lot) / 2, 0) / pairs.length;
    const avgPair = pairs.reduce((sum, x) => sum + (x.main + x.backup), 0) / pairs.length;
    setTradingCost(perLot, { pairs: pairs.length, measured: true, avg_pair_net: Math.round(avgPair * 100) / 100 });
  } catch (error) {
    console.warn(`[market] Could not measure trading cost (keeping the last value): ${error.message}`);
  }
};
