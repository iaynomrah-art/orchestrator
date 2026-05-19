import { supabase } from "../config/supabase.js";
import { BadRequestError } from "../errors/index.js";
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

    res.status(200).json({
      success: true,
      count: units.length,
      data: units,
    });

    // Update status field conditionally in the background after sending the response
    const updatePromises = (units || []).map(async (unit) => {
      let newStatus = null;
      if (unit.status === "processing" || unit.status === "disabled") {
        return; // Do not change
      } else if (unit.status === "enabled") {
        newStatus = "not connected";
      } else {
        newStatus = "enabled";
      }

      if (newStatus) {
        await supabase
          .from("units")
          .update({ status: newStatus })
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
        .eq("status", "enabled");

      if (error) {
        throw new BadRequestError(`Supabase error: ${error.message}`);
      }

      targetUnitIds = (activeUnits || []).map((u) => u.unit_id);
    }

    if (targetUnitIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No active units found to ping",
        pinged: 0,
        details: []
      });
    }

    const pingResults = [];

    // Broadcast to each unit's channel in parallel
    await Promise.all(
      targetUnitIds.map(async (unitId) => {
        const channelName = `unit_${unitId}`;
        const transactionId = req.body?.transaction_id || req.body?.transactionId || crypto.randomUUID();
        const channel = supabase.channel(channelName);

        try {
          // Send broadcast using HTTP/REST
          const response = await channel.send({
            type: "broadcast",
            event: "ping",
            payload: {
              transaction_id: transactionId,
              timestamp: new Date().toISOString()
            }
          });

          // Remove the channel from client memory
          await supabase.removeChannel(channel);

          pingResults.push({
            unit_id: unitId,
            channel: channelName,
            transaction_id: transactionId,
            status: response
          });
        } catch (err) {
          pingResults.push({
            unit_id: unitId,
            channel: channelName,
            transaction_id: transactionId,
            status: "error",
            error: err.message
          });
        }
      })
    );

    res.status(200).json({
      success: true,
      message: `Successfully sent broadcast ping to ${targetUnitIds.length} units`,
      pinged: targetUnitIds.length,
      details: pingResults
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Helper function to broadcast to a unit's channel and wait for the response.
 */
const broadcastAndWait = (unitId, event, payload = {}, timeoutMs = 30000, expectedReplyEvent = null) => {
  return new Promise((resolve, reject) => {
    const channelName = `unit_${unitId}`;
    const transactionId = payload.transaction_id || crypto.randomUUID();
    const listenEvent = expectedReplyEvent || (event === "ping" ? "pong" : "trade_result");
    
    const channel = supabase.channel(channelName);
    let timeoutId;

    const cleanup = async () => {
      if (timeoutId) clearTimeout(timeoutId);
      await supabase.removeChannel(channel);
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(async () => {
        await cleanup();
        reject(new Error(`Timeout: No response from unit ${unitId} within ${timeoutMs / 1000}s on event '${event}'`));
      }, timeoutMs);
    }

    // Set up the listener
    channel.on(
      "broadcast",
      { event: listenEvent },
      async (responsePayload) => {
        const data = responsePayload.payload || {};
        const txId = data.transaction_id || data.reply_to;

        if (txId === transactionId) {
          const resultStatus = data.result?.status || data.status;
          // Ignore intermediate status messages
          if (resultStatus === 'monitoring' || resultStatus === 'processing' || resultStatus === 'started') {
            return;
          }
          await cleanup();
          resolve(data);
        }
      }
    );

    // Subscribe and send
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "joined") {
        channel.send({
          type: "broadcast",
          event: event,
          payload: {
            ...payload,
            transaction_id: transactionId,
          }
        }).catch(async (err) => {
          await cleanup();
          reject(new Error(`Failed to send broadcast: ${err.message}`));
        });
      } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
        cleanup().then(() => {
          reject(new Error(`WebSocket channel failed or closed: ${status}`));
        });
      }
    });
  });
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
 * Automates the pairing process: saving to DB, checking connections, staging trades, updating status.
 * @route POST /api/v1/units/pair
 */
export const pairUnitsAction = async (req, res, next) => {
  let savedPairId = null;
  const {
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
    p2Payload
  } = req.body || {};

  try {
    if (!primary_id || !secondary_id || !unit1Id || !unit2Id) {
      throw new BadRequestError("primary_id, secondary_id, unit1Id, and unit2Id are required");
    }

    // 1. Save to DB Immediately with status 'initializing'
    const { data: pairedRecord, error: insertError } = await supabase
      .from('paired_accounts')
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

    // 3. Pre-flight Ping check
    try {
      await Promise.all([
        broadcastAndWait(unit1Id, 'ping', {}, 10000),
        broadcastAndWait(unit2Id, 'ping', {}, 10000)
      ]);
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
      throw new Error(`Stage orders failed: ${e.message}`);
    }

    const p1Result = p1Res?.result || p1Res || {};
    const p2Result = p2Res?.result || p2Res || {};

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
      .from('paired_accounts')
      .update({ trade_status: 'paired' })
      .eq('id', savedPairId);

    if (finalUpdateError) {
      console.error("Failed to update final pair status to paired:", finalUpdateError);
    }

    res.status(200).json({
      success: true,
      message: "Accounts successfully paired and staged via Orchestrator!",
      pairedRecord: pairedRecord?.[0],
      p1Result,
      p2Result
    });

  } catch (error) {
    console.error("Pairing error in Orchestrator:", error);
    
    // Rollback DB Changes
    if (savedPairId) {
      try {
        await supabase.from('paired_accounts').delete().eq('id', savedPairId);
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
