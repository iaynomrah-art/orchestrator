import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_SECRET_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

function broadcastAndWait(unitId, event, payload = {}, timeoutMs = 30000, expectedReplyEvent = null) {
  return new Promise((resolve, reject) => {
    const channelName = `unit_${unitId}`;
    const transactionId = payload.transaction_id || crypto.randomUUID();
    const listenEvent = expectedReplyEvent || (event === "ping" ? "pong" : "trade_result");
    
    console.log(`[test] Creating channel: ${channelName}`);
    const channel = supabase.channel(channelName);
    let timeoutId;
    let isCleaningUp = false;

    const cleanup = async () => {
      if (isCleaningUp) return;
      isCleaningUp = true;
      if (timeoutId) clearTimeout(timeoutId);
      console.log(`[test] Removing channel: ${channelName}`);
      await supabase.removeChannel(channel);
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(async () => {
        await cleanup();
        reject(new Error(`Timeout: No response from unit ${unitId} within ${timeoutMs / 1000}s on event '${event}'`));
      }, timeoutMs);
    }

    channel.on(
      "broadcast",
      { event: listenEvent },
      async (responsePayload) => {
        console.log(`[test] Received broadcast event:`, responsePayload);
        const data = responsePayload.payload || {};
        const txId = data.transaction_id || data.reply_to;

        if (!txId || txId === transactionId) {
          // Resolve first, then clean up asynchronously to prevent closed status from rejecting
          resolve(data);
          cleanup();
        }
      }
    );

    channel.subscribe((status, err) => {
      console.log(`[test] Channel status change: ${status}`, err || "");

      if (status === "SUBSCRIBED" || status === "joined") {
        console.log(`[test] Subscribed successfully. Sending broadcast via REST API...`);
        
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
          console.log("[test] Broadcast sent successfully via REST!");
        })
        .catch(async (err) => {
          console.error("[test] HTTP Broadcast send failed:", err);
          cleanup();
          reject(err);
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

async function run() {
  try {
    const res = await broadcastAndWait("d0d83e31-a2b6-43fb-baed-19b6b86fb178", "ping", {}, 10000, "pong");
    console.log("Success! Result:", res);
  } catch (err) {
    console.error("Failed:", err.message);
  }
  process.exit(0);
}

run();
