import { supabase } from "../config/supabase.js";
import { BadRequestError } from "../errors/index.js";
import { broadcastAndWait } from "../helper/broadcastHelper.js";
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

      const unit1Online = unit1.last_seen && (now - new Date(unit1.last_seen).getTime() < 180000);
      const unit2Online = unit2.last_seen && (now - new Date(unit2.last_seen).getTime() < 180000);

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

