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
    
    // Combine possible array fields from body
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
        const transactionId = crypto.randomUUID();
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
