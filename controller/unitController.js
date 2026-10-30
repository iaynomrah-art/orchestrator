import { supabase } from "../config/supabase.js";
import { BadRequestError } from "../errors/index.js";
import { broadcastAndWait } from "../helper/broadcastHelper.js";
import { planDelayedHedge, HEDGE_TRIGGER_PCT } from "../helper/hedgeHelper.js";
import crypto from "crypto";

/**
 * Get all units from Supabase
 * @route GET /api/v1/units
 */
export const getAllUnits = async (req, res, next) => {
  try {
    const { data: units, error } = await supabase
      .from("units")
      .select("*")
      .order("unit_name", { ascending: true });

    if (error) {
      throw new BadRequestError(`Supabase error: ${error.message}`);
    }

    // Determine online status based on last_seen (e.g. within 3 minutes / 180000ms)
    const now = Date.now();
    const updatedUnits = (units || []).map((unit) => {
      const isOnline = unit.last_seen && (now - new Date(unit.last_seen).getTime() < 180000);
      let updatedStatus = unit.status;
      if (isOnline) {
        if (unit.status === "not connected" || unit.status === "pc issue" || !unit.status) {
          updatedStatus = "enabled";
        }
      } else {
        if (unit.status !== "not connected" && unit.status !== "disabled") {
          updatedStatus = "not connected";
        }
      }
      return { ...unit, status: updatedStatus };
    });

    res.status(200).json({
      success: true,
      count: updatedUnits.length,
      data: updatedUnits,
    });

    // Update status field conditionally in the background after sending the response
    const updatePromises = updatedUnits.map(async (unit) => {
      const originalUnit = units.find(u => u.id === unit.id);
      if (originalUnit && originalUnit.status !== unit.status) {
        await supabase
          .from("units")
          .update({ status: unit.status })
          .eq("id", unit.id);
      }
    });

    Promise.all(updatePromises).catch((err) => {
      console.error("Error updating unit statuses in the background:", err);
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Ping specified units by sending a broadcast to each unit's channel (unit_${unit_id})
 * @route POST /api/v1/units/ping
 */
export const pingUnits = async (req, res, next) => {
  try {
    const { unitIds, unit_ids, units } = req.body || {};
    
    let targetUnitIds = unitIds || unit_ids || units;

    // If no unit IDs are provided, fetch all active units from the database
    if (!targetUnitIds || !Array.isArray(targetUnitIds) || targetUnitIds.length === 0) {
      const { data: activeUnits, error } = await supabase
        .from("units")
        .select("unit_id")
        .or("archived.eq.false,archived.is.null");

      if (error) {
        throw new BadRequestError(`Supabase error: ${error.message}`);
      }

      targetUnitIds = (activeUnits || []).map((u) => u.unit_id);
    }

    if (targetUnitIds.length === 0) {
      return res.status(200).json({
        success: false,
        status: 'failed',
        message: "No active units found to ping",
        pinged: 0,
        details: []
      });
    }

    // Query status and last_seen for all target units from the DB
    const { data: dbUnits, error: fetchError } = await supabase
      .from("units")
      .select("*")
      .in("unit_id", targetUnitIds);

    if (fetchError) {
      throw new BadRequestError(`Supabase error: ${fetchError.message}`);
    }

    // Map units to their GUIDs and ping them in parallel
    const pingPromises = targetUnitIds.map(async (unitId) => {
      const unit = (dbUnits || []).find((u) => u.unit_id === unitId || u.id === unitId);
      const guid = unit ? unit.unit_id : unitId;
      const channelName = `unit_${guid}`;
      const transactionId = crypto.randomUUID();

      if (!unit) {
        return {
          unit_id: unitId,
          channel: channelName,
          status: "error",
          error: "Unit not found in database"
        };
      }

      try {
        const pongResponse = await broadcastAndWait(guid, "ping", {}, 5000, "pong");
        
        let newStatus = unit.status;
        if (unit.status === "not connected" || unit.status === "pc issue" || !unit.status) {
          newStatus = "enabled";
        }

        if (newStatus !== unit.status) {
          await supabase
            .from("units")
            .update({ status: newStatus })
            .eq("id", unit.id);
        }

        return {
          unit_id: guid,
          channel: channelName,
          transaction_id: transactionId,
          status: "success",
          response: pongResponse
        };
      } catch (err) {
        let newStatus = unit.status;
        if (unit.status !== "not connected" && unit.status !== "disabled") {
          newStatus = "not connected";
        }

        if (newStatus !== unit.status) {
          await supabase
            .from("units")
            .update({ status: newStatus })
            .eq("id", unit.id);
        }

        return {
          unit_id: guid,
          channel: channelName,
          transaction_id: transactionId,
          status: "error",
          error: err.message
        };
      }
    });

    const pingResults = await Promise.all(pingPromises);
    const successfulPings = pingResults.filter(r => r.status === 'success').length;
    const success = successfulPings > 0;

    res.status(200).json({
      success,
      status: success ? 'success' : 'failed',
      message: `Successfully verified heartbeat for ${successfulPings}/${targetUnitIds.length} units`,
      pinged: successfulPings,
      details: pingResults
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Broadcast an event to a unit and wait for its reply.
 * @route POST /api/v1/units/broadcast
 */
export const broadcastToUnitAction = async (req, res, next) => {
  try {
    const { unitId, event, payload, timeoutMs, expectedReplyEvent } = req.body || {};

    if (!unitId) {
      throw new BadRequestError("unitId is required");
    }
    if (!event) {
      throw new BadRequestError("event is required");
    }

    const result = await broadcastAndWait(
      unitId,
      event,
      payload,
      timeoutMs || 30000,
      expectedReplyEvent
    );

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get a live SL/TP clearance quote for both legs of a prospective pair trade.
 * Read-only — does not stage or execute anything, so unlike pair/pair-execute
 * there is nothing to roll back on partial failure. One leg being offline or
 * slow doesn't prevent the other leg's quote from coming back.
 * @route POST /api/v1/units/quote-pair
 */
export const getPairQuote = async (req, res, next) => {
  try {
    const { unit1Id, unit2Id, p1Event, p1Payload, p2Event, p2Payload } = req.body || {};

    if (!unit1Id || !unit2Id) {
      throw new BadRequestError("unit1Id and unit2Id are required");
    }
    if (!p1Event || !p2Event) {
      throw new BadRequestError("p1Event and p2Event are required");
    }

    const QUOTE_TIMEOUT_MS = 8000;

    const [p1Settled, p2Settled] = await Promise.allSettled([
      broadcastAndWait(unit1Id, p1Event, p1Payload, QUOTE_TIMEOUT_MS),
      broadcastAndWait(unit2Id, p2Event, p2Payload, QUOTE_TIMEOUT_MS)
    ]);

    const toQuote = (settled) => {
      if (settled.status === "fulfilled") {
        return settled.value?.result || settled.value || {};
      }
      return { error: settled.reason?.message || "Failed to get quote" };
    };

    res.status(200).json({
      success: true,
      p1Quote: toQuote(p1Settled),
      p2Quote: toQuote(p2Settled)
    });
  } catch (error) {
    next(error);
  }
};

const SIGNAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const normalizeSymbol = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Link a pair to the market signal that set its direction, only when that's
 * actually what happened: the signal exists, is for this symbol, is recent, and
 * the primary leg took the signal's direction. Otherwise the pair gets no signal
 * (its direction was set manually), never a mismatched explanation.
 */
const resolvePairSignal = async (signalId, symbol, primaryOrderType) => {
  if (!signalId) return null;
  const { data: signal, error } = await supabase
    .from("market_signals")
    .select("id, symbol, direction, created_at, confidence, source, inputs")
    .eq("id", signalId)
    .maybeSingle();

  if (error || !signal) {
    console.warn(`[pair] Signal ${signalId} not found; pairing without it`);
    return null;
  }
  if (normalizeSymbol(signal.symbol) !== normalizeSymbol(symbol || "XAUUSD")) {
    console.warn(`[pair] Signal ${signalId} is for ${signal.symbol}, not ${symbol}; pairing without it`);
    return null;
  }
  if (String(primaryOrderType || "").toLowerCase() !== signal.direction) {
    console.warn(`[pair] Primary side (${primaryOrderType}) differs from signal ${signalId} (${signal.direction}); pairing without it`);
    return null;
  }
  if (Date.now() - new Date(signal.created_at).getTime() > SIGNAL_MAX_AGE_MS) {
    console.warn(`[pair] Signal ${signalId} is older than 6h; pairing without it`);
    return null;
  }
  return signal;
};

// Test mode (skip the AI score) only works when the server allows it — never on by default
const testModeAvailable = () => process.env.DELAYED_HEDGE_ALLOW_TEST_MODE === "true";

// Runs the delayed hedge rules for a pairing request body (same fields /pair takes)
const planPairStrategy = async (body) => {
  const signal = await resolvePairSignal(body.signal_id, body.symbol, body.primary_order_type);
  const plan = planDelayedHedge({
    testMode: body.test_mode === true && testModeAvailable(),
    enabled: process.env.DELAYED_HEDGE_ENABLED === "true",
    minScore: Number(process.env.DELAYED_HEDGE_MIN_SCORE) || 70,
    signal,
    events: [body.p1Event, body.p2Event],
    operations: [body.p1Payload?.operation, body.p2Payload?.operation],
    primary: {
      order_amount: body.primary_order_amount, stop_loss: body.primary_stop_loss, take_profit: body.primary_take_profit,
      sl_type: body.primary_sl_type ?? "dollar", tp_type: body.primary_tp_type ?? "dollar",
    },
    primarySafeLimit: body.primary_safe_limit,
    secondarySafeLimit: body.secondary_safe_limit,
  });
  return { signal, plan, score: signal?.confidence ?? null };
};

/**
 * Read-only: would this pair be allowed to use the delayed hedge? Lets the
 * pairing screen show the result and offer the choice before anything is staged.
 * @route POST /api/v1/units/pair/strategy
 */
export const pairStrategyAction = async (req, res, next) => {
  try {
    const { plan, score } = await planPairStrategy(req.body || {});
    res.status(200).json({
      delayed_allowed: plan.strategy === "delayed_hedge",
      reason: plan.reason,
      score,
      swap: Boolean(plan.swap),
      hedge: plan.hedge ?? null,
      trigger_pct: plan.trigger_pct ?? null,
      test_mode_available: testModeAvailable(),
    });
  } catch (error) {
    next(error);
  }
};

// Fields that belong to the account (not the trade) in a unit command payload
const ACCOUNT_PAYLOAD_FIELDS = ["username", "password", "server", "account_id", "db_account_id"];
const swapAccounts = (p1, p2) => {
  const pick = (p) => Object.fromEntries(ACCOUNT_PAYLOAD_FIELDS.map((k) => [k, p?.[k]]));
  return [{ ...p1, ...pick(p2) }, { ...p2, ...pick(p1) }];
};

/**
 * Automates the pairing process: saving to DB, checking connections, staging trades, updating status.
 * @route POST /api/v1/units/pair
 */
export const pairUnitsAction = async (req, res, next) => {
  let savedPairId = null;
  let {
    primary_id,
    secondary_id,
    symbol,
    primary_order_amount,
    primary_order_type,
    primary_take_profit,
    primary_stop_loss,
    secondary_order_amount,
    secondary_order_type,
    secondary_take_profit,
    secondary_stop_loss,
    unit1Id,
    unit2Id,
    p1Event,
    p1Payload,
    p2Event,
    p2Payload,
    signal_id
  } = req.body || {};

  try {
    if (!primary_id || !secondary_id || !unit1Id || !unit2Id) {
      throw new BadRequestError("primary_id, secondary_id, unit1Id, and unit2Id are required");
    }

    let { signal: linkedSignal, plan } = await planPairStrategy(req.body || {});
    const linkedSignalId = linkedSignal?.id ?? null;

    // The pairing screen sends the user's pick; without one (older dashboard) the rules decide
    const { strategy_choice } = req.body || {};
    if (strategy_choice === "natural" && plan.strategy === "delayed_hedge") {
      plan = { strategy: "natural", reason: "Natural hedge chosen on the pairing screen" };
    } else if (strategy_choice === "delayed_hedge" && plan.strategy !== "delayed_hedge") {
      // Something changed since the screen checked (e.g. signal expired, equity moved)
      throw new BadRequestError(`Delayed hedge is no longer allowed for this pair: ${plan.reason}. Pick natural hedge or re-check.`);
    }
    console.log(`[pair] Strategy: ${plan.strategy} — ${plan.reason}`);

    if (plan.strategy === "delayed_hedge") {
      if (plan.swap) {
        // Keep the trade, swap which account runs which leg
        [primary_id, secondary_id] = [secondary_id, primary_id];
        [unit1Id, unit2Id] = [unit2Id, unit1Id];
        [p1Payload, p2Payload] = swapAccounts(p1Payload, p2Payload);
      }
      secondary_order_amount = plan.hedge.order_amount;
      secondary_stop_loss = plan.hedge.stop_loss;
      secondary_take_profit = plan.hedge.take_profit;
      // Staging checks margin/stops for the real hedge size; the live hedge levels
      // are the primary's SL/TP prices, set once the primary is open
      p2Payload = {
        ...p2Payload,
        order_amount: secondary_order_amount,
        stop_loss: secondary_stop_loss,
        take_profit: secondary_take_profit,
        sl_type: "dollar",
        tp_type: "dollar",
      };
    }

    // 1. Save to DB Immediately with status 'initializing'
    const { data: pairedRecord, error: insertError } = await supabase
      .from('paired_trading_accounts')
      .insert({
        primary_account_id: primary_id,
        secondary_account_id: secondary_id,
        symbol: symbol || "XAUUSD",
        primary_order_amount,
        primary_order_type,
        primary_take_profit,
        primary_stop_loss,
        secondary_order_amount,
        secondary_order_type,
        secondary_take_profit,
        secondary_stop_loss,
        trade_status: 'initializing',
        is_active: true,
        // Only sent when linking, so pairing keeps working before the signals migration has run
        ...(linkedSignalId ? { signal_id: linkedSignalId } : {}),
        // Natural pairs send nothing new, so they keep working before the delayed hedge migration has run
        ...(plan.strategy === "delayed_hedge"
          ? { strategy: "delayed_hedge", hedge_status: "standby", hedge_trigger_pct: plan.trigger_pct ?? HEDGE_TRIGGER_PCT }
          : {}),
      })
      .select();

    if (insertError) {
      throw new Error(`Failed to save pair record: ${insertError.message}`);
    }

    savedPairId = pairedRecord?.[0]?.id;

    // 2. Mark trading accounts as 'paired'
    const { error: updateAccountsError } = await supabase
      .from('trading_accounts')
      .update({ account_status: 'paired' })
      .in('id', [primary_id, secondary_id]);

    if (updateAccountsError) {
      throw new Error(`Failed to update trading accounts status: ${updateAccountsError.message}`);
    }

    // 3. Pre-flight Ping check using database heartbeats (last_seen)
    try {
      const { data: dbUnits, error: fetchError } = await supabase
        .from("units")
        .select("*")
        .in("unit_id", [unit1Id, unit2Id]);

      if (fetchError) {
        throw new Error(`Failed to query units: ${fetchError.message}`);
      }

      const now = Date.now();
      const unit1 = (dbUnits || []).find(u => u.unit_id === unit1Id);
      const unit2 = (dbUnits || []).find(u => u.unit_id === unit2Id);

      if (!unit1) {
        throw new Error(`Primary unit (${unit1Id}) not found in database`);
      }
      if (!unit2) {
        throw new Error(`Secondary unit (${unit2Id}) not found in database`);
      }

      // Workers only write last_seen every ~2 minutes, so one missed or slow DB pulse
      // pushes a running unit past the 3-minute window. When the heartbeat is stale,
      // ping the unit live before declaring it offline.
      const isOnline = async (unit) => {
        if (unit.last_seen && (now - new Date(unit.last_seen).getTime() < 180000)) {
          return true;
        }
        try {
          await broadcastAndWait(unit.unit_id, "ping", {}, 8000, "pong");
          console.log(`[pairUnitsAction] ${unit.unit_name} heartbeat stale but answered live ping`);
          return true;
        } catch {
          return false;
        }
      };
      const [unit1Online, unit2Online] = await Promise.all([isOnline(unit1), isOnline(unit2)]);

      if (!unit1Online) {
        throw new Error(`Primary unit (${unit1.unit_name || unit1Id}) is not connected (offline)`);
      }
      if (!unit2Online) {
        throw new Error(`Secondary unit (${unit2.unit_name || unit2Id}) is not connected (offline)`);
      }
    } catch (e) {
      throw new Error(`Pre-flight connection check failed: ${e.message}`);
    }

    // 4. Stage Orders (Input Only)
    let p1Res, p2Res;
    try {
      [p1Res, p2Res] = await Promise.all([
        broadcastAndWait(unit1Id, p1Event, p1Payload, 60000),
        broadcastAndWait(unit2Id, p2Event, p2Payload, 60000)
      ]);
    } catch (e) {
      // Reconcile against the DB regardless of the failure mode (timeout, WS-send
      // failure, channel drop, ...) — the command can have been delivered and
      // executed on the local worker even when the acknowledgment channel itself
      // failed, and rolling back here would otherwise delete a pair record for a
      // trade that's actually running.
      const { data: checkPair, error: checkErr } = await supabase
        .from('paired_trading_accounts')
        .select('trade_status, primary_automation_status, secondary_automation_status')
        .eq('id', savedPairId)
        .single();

      if (!checkErr && checkPair) {
        if (checkPair.primary_automation_status === 'success' && checkPair.secondary_automation_status === 'success') {
          p1Res = { result: { success: true, status: 'success', message: 'Resolved via DB fallback' } };
          p2Res = { result: { success: true, status: 'success', message: 'Resolved via DB fallback' } };
        } else {
          throw new Error(`Stage orders failed (DB fallback unsuccessful): ${e.message}`);
        }
      } else {
        throw new Error(`Stage orders failed: ${e.message}`);
      }
    }

    const p1Result = p1Res?.result || p1Res || {};
    const p2Result = p2Res?.result || p2Res || {};

    // Cache the broker's min_stop_distance for future fast-UI validation
    const updateStopCache = async (accountId, result) => {
      const distance = result?.details?.min_stop_distance || result?.min_stop_distance || result?.order?.min_stop_distance;
      if (accountId && distance !== undefined) {
        await supabase.from('trading_accounts').update({ min_stop_distance: distance }).eq('id', accountId);
      }
    };
    updateStopCache(primary_id, p1Result).catch(console.error);
    updateStopCache(secondary_id, p2Result).catch(console.error);

    const p1Success = p1Result?.success !== false && p1Result?.status !== 'failed' && p1Result?.status !== 'error';
    const p2Success = p2Result?.success !== false && p2Result?.status !== 'failed' && p2Result?.status !== 'error';

    if (!p1Success) {
      throw new Error(`Primary machine staging failed: ${p1Result?.reason || p1Result?.message || 'Likely failed TP/SL validation.'}`);
    }
    if (!p2Success) {
      throw new Error(`Secondary machine staging failed: ${p2Result?.reason || p2Result?.message || 'Likely failed TP/SL validation.'}`);
    }

    // 5. Update pair status to 'paired'
    const { error: finalUpdateError } = await supabase
      .from('paired_trading_accounts')
      .update({ trade_status: 'paired' })
      .eq('id', savedPairId);

    if (finalUpdateError) {
      console.error("Failed to update final pair status to paired:", finalUpdateError);
    }

    res.status(200).json({
      success: true,
      message: "Accounts successfully paired and staged via Orchestrator!",
      pairedRecord: pairedRecord?.[0],
      strategy: plan.strategy,
      strategy_reason: plan.reason,
      swapped: Boolean(plan.swap),
      p1Result,
      p2Result
    });

  } catch (error) {
    console.error("Pairing error in Orchestrator:", error);
    
    // Rollback DB Changes
    if (savedPairId) {
      try {
        await supabase.from('paired_trading_accounts').delete().eq('id', savedPairId);
      } catch (delError) {
        console.error("Rollback delete pair failed:", delError);
      }

      try {
        await supabase
          .from('trading_accounts')
          .update({ account_status: 'idle' })
          .in('id', [primary_id, secondary_id]);
      } catch (updError) {
        console.error("Rollback accounts reset failed:", updError);
      }
    }

    next(error);
  }
};

// Local servers hold every automated close until the position is 125s old
// (GFT voids profit on shorter trades), so close commands can take that long
const CLOSE_WITH_HOLD_TIMEOUT_MS = 180000;

const isCloseOrTerminateOperation = (op) => {
  const o = String(op || "").toLowerCase();
  return o.startsWith("close") || o.startsWith("trade-terminator");
};

/**
 * Automatically close a leg that executed successfully when its partner leg
 * failed, so a partial pair-execution failure never leaves a naked position.
 * Best-effort: logs rather than throws if the compensating close itself fails
 * — that scenario needs the same close-failure surfacing/alerting as a normal
 * close failure, not a second layer of retries here.
 */
const compensateClose = async (unitId, event, originalPayload, role) => {
  const originalOperation = String(originalPayload?.operation || "");
  const closeOperation = originalOperation.endsWith("-gui") ? "close-position-gui" : "close-position";
  const closePayload = { ...originalPayload, operation: closeOperation };

  try {
    // The local close waits out the 125s minimum hold if the leg is in profit
    await broadcastAndWait(unitId, event, closePayload, CLOSE_WITH_HOLD_TIMEOUT_MS);
    console.log(`Compensation close sent for ${role} leg on unit ${unitId}`);
  } catch (e) {
    console.error(`Compensation close FAILED for ${role} leg on unit ${unitId}: ${e.message}`);
  }

  const dbAccountId = originalPayload?.db_account_id;
  if (!dbAccountId) return;

  try {
    const { data: activePair } = await supabase
      .from("paired_trading_accounts")
      .select("id")
      .or(`primary_account_id.eq.${dbAccountId},secondary_account_id.eq.${dbAccountId}`)
      .neq("trade_status", "done")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (activePair?.id) {
      await supabase.from("paired_trading_accounts").update({ trade_status: "failed" }).eq("id", activePair.id);
    }
  } catch (e) {
    console.error(`Failed to mark pair as 'failed' after compensation for ${role} leg:`, e.message);
  }
};

/**
 * Execute a synchronized action on a pair of units.
 * Used for Start Immediately, Force Close, and Recover.
 * @route POST /api/v1/units/pair/execute
 */
export const executePairAction = async (req, res, next) => {
  const { unit1Id, unit2Id, p1Event, p1Payload, p2Event, p2Payload, timeoutMs = 60000, fireAndForget = false } = req.body || {};

  try {
    if (!unit1Id || !unit2Id) {
      throw new BadRequestError("unit1Id and unit2Id are required");
    }

    if (fireAndForget) {
      Promise.all([
        broadcastAndWait(unit1Id, p1Event, p1Payload, 0).catch(() => {}),
        broadcastAndWait(unit2Id, p2Event, p2Payload, 0).catch(() => {})
      ]);

      return res.status(200).json({
        success: true,
        message: "Action sent asynchronously"
      });
    }

    let p1Res, p2Res;
    try {
      [p1Res, p2Res] = await Promise.all([
        broadcastAndWait(unit1Id, p1Event, p1Payload, timeoutMs),
        broadcastAndWait(unit2Id, p2Event, p2Payload, timeoutMs)
      ]);
    } catch (e) {
      if (e.message.includes("Timeout")) {
        const dbAccountId1 = p1Payload?.db_account_id;
        const dbAccountId2 = p2Payload?.db_account_id;
        
        let p1SuccessDB = false;
        let p2SuccessDB = false;
        
        // Latest pair only — .single() errors once an account has more than one pair row
        if (dbAccountId1) {
            const { data } = await supabase.from('paired_trading_accounts').select('primary_automation_status').eq('primary_account_id', dbAccountId1).order('created_at', { ascending: false }).limit(1).maybeSingle();
            if (data?.primary_automation_status === 'success') p1SuccessDB = true;
        }
        if (dbAccountId2) {
            const { data } = await supabase.from('paired_trading_accounts').select('secondary_automation_status').eq('secondary_account_id', dbAccountId2).order('created_at', { ascending: false }).limit(1).maybeSingle();
            if (data?.secondary_automation_status === 'success') p2SuccessDB = true;
        }

        if (p1SuccessDB && p2SuccessDB) {
           p1Res = { result: { success: true, status: 'success', message: 'Resolved via DB fallback' } };
           p2Res = { result: { success: true, status: 'success', message: 'Resolved via DB fallback' } };
        } else {
           throw new Error(`Execution failed (Timeout & DB fallback unsuccessful): ${e.message}`);
        }
      } else {
        throw new Error(`Execution failed: ${e.message}`);
      }
    }

    const p1Result = p1Res?.result || p1Res || {};
    const p2Result = p2Res?.result || p2Res || {};

    const p1Success = p1Result?.success !== false && p1Result?.status !== 'failed' && p1Result?.status !== 'error';
    const p2Success = p2Result?.success !== false && p2Result?.status !== 'failed' && p2Result?.status !== 'error';

    // Only opening actions (place-order etc.) risk leaving a naked position —
    // a partial failure on a close/terminate action is a close failure, handled
    // by the local worker's own close-failure surfacing, not a compensating close.
    const isOpeningAction = !isCloseOrTerminateOperation(p1Payload?.operation) && !isCloseOrTerminateOperation(p2Payload?.operation);

    if (p1Success && !p2Success) {
      const reason = `Secondary execution failed: ${p2Result?.reason || p2Result?.message || 'Unknown error'}`;
      if (isOpeningAction) {
        await compensateClose(unit1Id, p1Event, p1Payload, 'primary');
        throw new Error(`${reason}; primary leg was automatically closed to avoid a naked position.`);
      }
      throw new Error(reason);
    }
    if (p2Success && !p1Success) {
      const reason = `Primary execution failed: ${p1Result?.reason || p1Result?.message || 'Unknown error'}`;
      if (isOpeningAction) {
        await compensateClose(unit2Id, p2Event, p2Payload, 'secondary');
        throw new Error(`${reason}; secondary leg was automatically closed to avoid a naked position.`);
      }
      throw new Error(reason);
    }
    if (!p1Success && !p2Success) {
      throw new Error(`Both legs failed. Primary: ${p1Result?.reason || p1Result?.message || 'Unknown error'}. Secondary: ${p2Result?.reason || p2Result?.message || 'Unknown error'}.`);
    }

    res.status(200).json({
      success: true,
      p1Result,
      p2Result,
      message: "Action executed successfully"
    });
  } catch (error) {
    next(error);
  }
};

const PAIR_EXIT_CHANNEL = "pair-exit";
const PAIR_EXIT_EVENT = "exit";
const FORCE_CLOSE_SIGNAL = "force_close";
const isLegDone = (status) => status === "completed" || status === "close_failed";
// Terminator got the signal but is waiting out the minimum hold before it closes
const isLegHolding = (status) => status === "holding";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same REST broadcast the local workers use for exit signals — no channel join needed. */
const broadcastPairExit = async (pairId) => {
  const url = (process.env.PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_SECRET_KEY;
  const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{
        topic: PAIR_EXIT_CHANNEL,
        event: PAIR_EXIT_EVENT,
        payload: { pair_id: String(pairId), signal: FORCE_CLOSE_SIGNAL, triggered_by: "manual" },
        private: false,
      }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

const readLegStatuses = async (pairId) => {
  const { data, error } = await supabase
    .from("paired_trading_accounts")
    .select("primary_termination_status, secondary_termination_status")
    .eq("id", pairId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read pair status: ${error.message}`);
  return { primary: data?.primary_termination_status, secondary: data?.secondary_termination_status };
};

/**
 * Force close both legs of a running pair.
 *
 * A running trade's terminator holds its account's automation thread for the
 * whole trade, so a separate close-position command would just queue behind it
 * until the trade ends on its own. Instead, send the same exit signal a TP/SL
 * hit sends: each terminator closes its own leg within milliseconds and reports
 * its termination status. Only legs no terminator answers for get a direct
 * close-position command.
 * @route POST /api/v1/units/pair/force-close
 */
export const forceClosePairAction = async (req, res, next) => {
  const {
    pairId, unit1Id, unit2Id, p1Event, p1Payload, p2Event, p2Payload,
    terminatorWaitMs = 30000, closeTimeoutMs = CLOSE_WITH_HOLD_TIMEOUT_MS,
  } = req.body || {};
  // Set once a 202 went out because a leg is waiting out the minimum hold;
  // the rest then runs in the background and only logs its outcome
  let responded = false;

  try {
    if (!pairId) {
      throw new BadRequestError("pairId is required");
    }

    // 1. Signal both terminators: Realtime for speed, exit_signal in the DB as the fallback they poll
    const [dbSignal] = await Promise.all([
      supabase
        .from("paired_trading_accounts")
        .update({ exit_signal: FORCE_CLOSE_SIGNAL, exit_triggered_by: "manual" })
        .eq("id", pairId)
        .select("id"),
      broadcastPairExit(pairId).catch((e) =>
        console.warn(`[forceClosePair] Realtime exit broadcast failed, terminators will pick up the DB signal: ${e.message}`)
      ),
    ]);
    if (dbSignal.error) {
      throw new Error(`Failed to write exit signal: ${dbSignal.error.message}`);
    }
    if (!dbSignal.data?.length) {
      throw new BadRequestError(`Pair ${pairId} not found`);
    }

    // 2. Wait for the terminators to report each leg closed (or failed). A leg that
    // reports "holding" is alive but closes only once the trade is 125s old.
    let statuses = await readLegStatuses(pairId);
    const started = Date.now();
    let sawHolding = false;
    while (!(isLegDone(statuses.primary) && isLegDone(statuses.secondary))) {
      if (isLegHolding(statuses.primary) || isLegHolding(statuses.secondary)) sawHolding = true;
      if (sawHolding && !responded) {
        // Don't keep the dashboard request open for up to two minutes
        responded = true;
        res.status(202).json({
          success: true,
          holding: true,
          message: "Close signal received — the legs close once the trade is 125s old (minimum hold). Watch the trade for the result.",
        });
      }
      if (Date.now() - started >= (sawHolding ? CLOSE_WITH_HOLD_TIMEOUT_MS : terminatorWaitMs)) break;
      await sleep(500);
      statuses = await readLegStatuses(pairId);
    }

    // 3. Close any leg no terminator answered for directly
    const legs = [
      { role: "primary", unitId: unit1Id, event: p1Event, payload: p1Payload },
      { role: "secondary", unitId: unit2Id, event: p2Event, payload: p2Payload },
    ];
    const direct = {};
    await Promise.all(legs.filter((leg) => !isLegDone(statuses[leg.role])).map(async (leg) => {
      if (!leg.unitId || !leg.event) {
        direct[leg.role] = { closed: false, reason: "No terminator responded and no unit/event was given for a direct close" };
        return;
      }
      console.warn(`[forceClosePair] No terminator answered for ${leg.role} leg of pair ${pairId}; sending close-position directly`);
      try {
        const reply = await broadcastAndWait(leg.unitId, leg.event, leg.payload, closeTimeoutMs);
        const result = reply?.result || reply || {};
        const reason = result.reason || result.message;
        const ok = result.success !== false && result.status !== "failed" && result.status !== "error";
        direct[leg.role] = { closed: ok || /no active position|already closed/i.test(reason || ""), reason };
      } catch (e) {
        direct[leg.role] = { closed: false, reason: e.message };
      }
    }));

    // 4. Re-read: a slow terminator may have finished while the direct close was queued behind it
    statuses = await readLegStatuses(pairId);
    const now = new Date().toISOString();
    const update = { trade_status: "done", is_active: false };
    const outcome = {};
    for (const leg of legs) {
      const status = statuses[leg.role];
      if (isLegDone(status)) {
        outcome[leg.role] = { closed: status === "completed", status, via: direct[leg.role] ? "direct" : "terminator" };
        continue;
      }
      const d = direct[leg.role];
      const closed = Boolean(d?.closed);
      update[`${leg.role}_termination_status`] = closed ? "completed" : "close_failed";
      if (closed) update[`${leg.role}_close_time`] = now;
      outcome[leg.role] = { closed, status: update[`${leg.role}_termination_status`], via: "direct", reason: d?.reason };
    }

    const { error: finalError } = await supabase.from("paired_trading_accounts").update(update).eq("id", pairId);
    if (finalError) {
      console.error(`[forceClosePair] Failed to finalize pair ${pairId}:`, finalError.message);
    }

    const describe = (o) => (o.closed ? "closed" : `NOT closed (${o.reason || o.status})`);
    if (responded) {
      // The dashboard already got its 202; a close_failed leg shows there as NEEDS ATTENTION
      const log = outcome.primary.closed && outcome.secondary.closed ? console.log : console.error;
      log(`[forceClosePair] Pair ${pairId} after minimum hold — primary ${describe(outcome.primary)}, secondary ${describe(outcome.secondary)}`);
      return;
    }

    if (!outcome.primary.closed || !outcome.secondary.closed) {
      return res.status(502).json({
        success: false,
        message: `Force close incomplete — primary ${describe(outcome.primary)}, secondary ${describe(outcome.secondary)}. Check the open position manually.`,
        ...outcome,
      });
    }

    res.status(200).json({
      success: true,
      message: "Both legs closed",
      ...outcome,
    });
  } catch (error) {
    if (responded) {
      console.error(`[forceClosePair] Background finish failed for pair ${pairId}:`, error.message);
      return;
    }
    next(error);
  }
};

export const pingSingleUnit = async (req, res, next) => {
  try {
    const { unit_id } = req.params;

    if (!unit_id) {
      throw new BadRequestError("unit_id parameter is required");
    }

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(unit_id);

    let query = supabase.from("units").select("*");

    if (isUuid) {
      query = query.or(`unit_id.eq.${unit_id},id.eq.${unit_id}`);
    } else {
      query = query.eq("id", unit_id);
    }

    const { data: dbUnits, error: fetchError } = await query;

    if (fetchError) {
      throw new BadRequestError(`Supabase error: ${fetchError.message}`);
    }

    if (!dbUnits || dbUnits.length === 0) {
      return res.status(404).json({
        success: false,
        status: "failed",
        message: `Unit ${unit_id} not found in database`,
      });
    }

    const unit = dbUnits[0];
    const guid = unit.unit_id;

    if (!guid) {
      return res.status(400).json({
        success: false,
        status: "failed",
        message: `Unit ${unit_id} has no unit_id (GUID) assigned`,
      });
    }

    // FIX: Let broadcastAndWait own the transactionId — no need to generate it here.
    // Passing no transaction_id so broadcastAndWait generates and tracks it internally.
    let isOnline = false;
    let pongResponse = null;

    try {
      pongResponse = await broadcastAndWait(guid, "ping", {}, 5000, "pong");
      isOnline = true;
    } catch (err) {
      console.warn(`[pingSingleUnit] Unit ${guid} did not respond: ${err.message}`);
      isOnline = false;
    }

    let newStatus = unit.status;

    if (isOnline) {
      if (
        unit.status === "not connected" ||
        unit.status === "pc issue" ||
        !unit.status
      ) {
        newStatus = "enabled";
      }
    } else {
      if (unit.status !== "not connected" && unit.status !== "disabled") {
        newStatus = "not connected";
      }
    }

    if (newStatus !== unit.status) {
      const { error: updateError } = await supabase
        .from("units")
        .update({ status: newStatus })
        .eq("id", unit.id);

      if (updateError) {
        console.error(
          `[pingSingleUnit] Failed to update unit ${unit.id} status:`,
          updateError.message
        );
      } else {
        unit.status = newStatus;
      }
    }

    return res.status(200).json({
      success: isOnline,
      status: isOnline ? "success" : "failed",
      message: isOnline
        ? `Unit ${unit.unit_name} is connected`
        : `Unit ${unit.unit_name || unit_id} is not connected`,
      data: {
        id: unit.id,
        unit_id: unit.unit_id,
        unit_name: unit.unit_name,
        status: unit.status,
        last_seen: unit.last_seen,
      },
      pong: pongResponse,
    });
  } catch (error) {
    next(error);
  }
};

