import { supabase } from "../config/supabase.js";
import crypto from "crypto";

const activeChannels = new Map();

/**
 * Helper function to broadcast to a unit's channel and wait for the response.
 */
export function broadcastAndWait(unitId, event, payload = {}, timeoutMs = 30000, expectedReplyEvent = null, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const channelName = `unit_${unitId}`;
    const transactionId = payload.transaction_id || crypto.randomUUID();
    const listenEvent = expectedReplyEvent || (event === "ping" ? "pong" : "trade_result");

    let channelRecord = activeChannels.get(channelName);
    let channel;

    if (!channelRecord) {
      channel = supabase.channel(channelName);
      channelRecord = {
        channel,
        status: 'init',
        pendingRequests: 0,
        subscribers: [] // Callbacks waiting for the channel to join
      };
      activeChannels.set(channelName, channelRecord);
      
      channel.subscribe((status) => {
        console.log(`[broadcastAndWait] Channel "${channelName}" status: ${status} (Retry: ${retryCount})`);
        channelRecord.status = status;
        
        if (status === "SUBSCRIBED" || status === "joined") {
          // Notify all pending requests that we are subscribed
          channelRecord.subscribers.forEach(cb => cb(null));
          channelRecord.subscribers = [];
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          // Notify all pending requests of the error
          channelRecord.subscribers.forEach(cb => cb(new Error(`WebSocket channel failed or closed: ${status}`)));
          channelRecord.subscribers = [];
          
          if (activeChannels.get(channelName) === channelRecord) {
            activeChannels.delete(channelName);
          }
        }
      });
    } else {
      channel = channelRecord.channel;
    }

    channelRecord.pendingRequests++;
    let timeoutId;
    let isCleaningUp = false;

    const cleanup = async () => {
      if (isCleaningUp) return;
      isCleaningUp = true;
      if (timeoutId) clearTimeout(timeoutId);
      
      channelRecord.pendingRequests--;
      if (channelRecord.pendingRequests <= 0) {
        if (activeChannels.get(channelName) === channelRecord) {
          activeChannels.delete(channelName);
        }
        await supabase.removeChannel(channel);
      }
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(async () => {
        await cleanup();
        reject(new Error(`Timeout: No response from unit ${unitId} within ${timeoutMs / 1000}s on event '${event}'`));
      }, timeoutMs);
    }

    // Register our specific listener
    const onBroadcast = async (responsePayload) => {
      const data = responsePayload.payload || {};
      const txId = data.transaction_id || data.reply_to;

      if (txId && txId !== transactionId) {
        return; // Not ours
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

      console.log(`[broadcastAndWait] txId matched "${transactionId}", finishing...`);
      channel.off("broadcast", { event: listenEvent }, onBroadcast);
      resolve(data);
      cleanup();
    };

    channel.on("broadcast", { event: listenEvent }, onBroadcast);

    // Send the message once subscribed
    const sendMessage = () => {
      channel.send({
        type: 'broadcast',
        event: event,
        payload: {
          ...payload,
          transaction_id: transactionId,
        }
      })
      .then(() => {
        console.log(`[broadcastAndWait] Sent "${event}" with tx: ${transactionId} via WS`);
      })
      .catch((err) => {
        cleanup();
        reject(new Error(`Failed to send broadcast via WS: ${err.message}`));
      });
    };

    if (channelRecord.status === "SUBSCRIBED" || channelRecord.status === "joined") {
      sendMessage();
    } else if (channelRecord.status === "CHANNEL_ERROR" || channelRecord.status === "CLOSED") {
      cleanup();
      if (retryCount < 2) {
          console.log(`[broadcastAndWait] Retrying connection for ${unitId}...`);
          setTimeout(() => {
              broadcastAndWait(unitId, event, payload, timeoutMs, expectedReplyEvent, retryCount + 1)
                  .then(resolve)
                  .catch(reject);
          }, 1000);
      } else {
          reject(new Error(`WebSocket channel failed or closed: ${channelRecord.status}`));
      }
    } else {
      channelRecord.subscribers.push((err) => {
        if (err) {
          cleanup();
          if (retryCount < 2) {
              console.log(`[broadcastAndWait] Retrying connection for ${unitId} after callback error...`);
              setTimeout(() => {
                  broadcastAndWait(unitId, event, payload, timeoutMs, expectedReplyEvent, retryCount + 1)
                      .then(resolve)
                      .catch(reject);
              }, 1000);
          } else {
              reject(err);
          }
        } else {
          sendMessage();
        }
      });
    }
  });
}