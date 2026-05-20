import { supabase } from "../config/supabase.js";
import crypto from "crypto";

/**
 * Helper function to broadcast to a unit's channel and wait for the response.
 */
export function broadcastAndWait(unitId, event, payload = {}, timeoutMs = 30000, expectedReplyEvent = null) {
  return new Promise((resolve, reject) => {
    const channelName = `unit_${unitId}`;
    const transactionId = payload.transaction_id || crypto.randomUUID();
    const listenEvent = expectedReplyEvent || (event === "ping" ? "pong" : "trade_result");

    const channel = supabase.channel(channelName);
    let timeoutId;
    let isCleaningUp = false;

    const cleanup = async () => {
      if (isCleaningUp) return;
      isCleaningUp = true;
      if (timeoutId) clearTimeout(timeoutId);
      await supabase.removeChannel(channel);
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(async () => {
        await cleanup();
        reject(new Error(`Timeout: No response from unit ${unitId} within ${timeoutMs / 1000}s on event '${event}'`));
      }, timeoutMs);
    }

    // Listen BEFORE subscribing
    channel.on(
      "broadcast",
      { event: listenEvent },
      async (responsePayload) => {
        console.log(`[broadcastAndWait] RAW ${listenEvent} received:`, JSON.stringify(responsePayload, null, 2));

        const data = responsePayload.payload || {};
        const txId = data.transaction_id || data.reply_to;

        console.log(`[broadcastAndWait] txId from response: "${txId}" | expected: "${transactionId}"`);

        const txMatches = !txId || txId === transactionId;
        if (!txMatches) {
          console.log(`[broadcastAndWait] transaction_id mismatch — ignoring`);
          return;
        }

        const resultStatus = data.result?.status || data.status;
        if (
          resultStatus === "monitoring" ||
          resultStatus === "processing" ||
          resultStatus === "started"
        ) {
          console.log(`[broadcastAndWait] Intermediate status "${resultStatus}" — waiting`);
          return;
        }

        resolve(data);
        cleanup();
      }
    );

    channel.subscribe((status) => {
      console.log(`[broadcastAndWait] Channel "${channelName}" status: ${status}`);

      if (status === "SUBSCRIBED" || status === "joined") {
        const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_SECRET_KEY;

        fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
          method: "POST",
          headers: {
            "apikey": supabaseKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messages: [
              {
                topic: channelName,
                event: event,
                payload: {
                  ...payload,
                  transaction_id: transactionId,
                }
              }
            ]
          })
        })
        .then(async (res) => {
          if (!res.ok) {
            const txt = await res.text();
            throw new Error(`HTTP ${res.status}: ${txt}`);
          }
          console.log(`[broadcastAndWait] Sent "${event}" with tx: ${transactionId} via REST`);
        })
        .catch((err) => {
          cleanup();
          reject(new Error(`Failed to send broadcast via REST: ${err.message}`));
        });

      } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
        if (!isCleaningUp) {
          cleanup().then(() => {
            reject(new Error(`WebSocket channel failed or closed: ${status}`));
          });
        }
      }
    });
  });
}