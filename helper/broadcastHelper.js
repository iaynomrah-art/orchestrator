import { supabase } from "../config/supabase.js";
import crypto from "crypto";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logFile = path.join(__dirname, '../broadcast_debug.log');

const log = (msg) => {
  // debug logs removed
};

const activeChannels = new Map();

/**
 * Helper function to broadcast to a unit's channel and wait for the response.
 */
export function broadcastAndWait(unitId, event, payload = {}, timeoutMs = 30000, expectedReplyEvent = null, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const channelName = `unit_${unitId}`;
    const transactionId = payload.transaction_id || crypto.randomUUID();
    const listenEvent = expectedReplyEvent || (event === "ping" ? "pong" : "trade_result");
    log(`[${channelName}] broadcastAndWait called for event=${event}, listenEvent=${listenEvent}, timeout=${timeoutMs}`);

    let channelRecord = activeChannels.get(channelName);
    let channel;

    if (!channelRecord || channelRecord.status === "CHANNEL_ERROR" || channelRecord.status === "CLOSED") {
      if (channelRecord && channelRecord.channel) {
        log(`[${channelName}] Removing dead channel before recreating...`);
        supabase.removeChannel(channelRecord.channel).catch(() => {});
        activeChannels.delete(channelName);
      }

      channel = supabase.channel(channelName);
      channelRecord = {
        channel,
        status: 'init',
        pendingRequests: 0,
        subscribers: [], // Callbacks waiting for the channel to join
        requests: new Map(),
        cleanupTimeout: null
      };
      activeChannels.set(channelName, channelRecord);

      const handleBroadcast = async (responsePayload) => {
        const data = responsePayload.payload || {};
        const eventName = responsePayload.event;
        const txId = data.transaction_id || data.reply_to;
        log(`[${channelName}] Incoming broadcast: eventName=${eventName}, txId=${txId}, data=${JSON.stringify(data)}`);

        if (!txId) {
            log(`[${channelName}] No txId found, skipping.`);
            return;
        }

        const req = channelRecord.requests.get(txId);
        if (req) {
          const resultStatus = data.result?.status || data.status;
          if (
            resultStatus === "monitoring" ||
            resultStatus === "processing" ||
            resultStatus === "started"
          ) {
            log(`[${channelName}] txId matched "${txId}", Intermediate status "${resultStatus}" — waiting`);
            return;
          }

          log(`[${channelName}] txId matched "${txId}", finishing...`);
          req.resolve(data);
          req.cleanup();
        } else {
          log(`[${channelName}] txId "${txId}" NOT FOUND in requests map! Current keys: ${Array.from(channelRecord.requests.keys()).join(', ')}`);
        }
      };

      // Register specific listeners BEFORE subscribing
      channel.on("broadcast", { event: "pong" }, handleBroadcast);
      channel.on("broadcast", { event: "trade_result" }, handleBroadcast);
      channel.on("broadcast", { event: "status_update" }, handleBroadcast);
      
      channel.subscribe((status) => {
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
             // Don't auto-delete here, let the next broadcastAndWait clean it up
             // so we don't accidentally leave dangling references.
          }
        }
      });
    } else {
      channel = channelRecord.channel;
      if (channelRecord.cleanupTimeout) {
        clearTimeout(channelRecord.cleanupTimeout);
        channelRecord.cleanupTimeout = null;
      }
    }

    channelRecord.pendingRequests++;
    let timeoutId;
    let isCleaningUp = false;

    const cleanup = async () => {
      if (isCleaningUp) return;
      isCleaningUp = true;
      if (timeoutId) clearTimeout(timeoutId);
      
      log(`[${channelName}] cleanup for txId=${transactionId}`);
      channelRecord.requests.delete(transactionId);
      channelRecord.pendingRequests--;
      if (channelRecord.pendingRequests <= 0) {
        channelRecord.cleanupTimeout = setTimeout(async () => {
          if (channelRecord.pendingRequests <= 0) {
            if (activeChannels.get(channelName) === channelRecord) {
              activeChannels.delete(channelName);
            }
            await supabase.removeChannel(channel);
          }
        }, 15000); // Wait 15s before closing to avoid Phoenix leave/join race conditions
      }
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(async () => {
        log(`[${channelName}] TIMEOUT for txId=${transactionId}, event=${event}`);
        await cleanup();
        reject(new Error(`Timeout: No response from unit ${unitId} within ${timeoutMs / 1000}s on event '${event}'`));
      }, timeoutMs);
    }

    // Register request
    channelRecord.requests.set(transactionId, { resolve, cleanup });

    // Send the message once subscribed
    const sendMessage = () => {
      log(`[${channelName}] sendMessage: event=${event}, txId=${transactionId}`);
      channel.send({
        type: 'broadcast',
        event: event,
        payload: {
          ...payload,
          transaction_id: transactionId,
        }
      })
      .then((resp) => {
        log(`[${channelName}] sendMessage success resp=${resp}`);
      })
      .catch((err) => {
        log(`[${channelName}] sendMessage failed err=${err}`);
        cleanup();
        reject(new Error(`Failed to send broadcast via WS: ${err.message}`));
      });
    };

    if (channelRecord.status === "SUBSCRIBED" || channelRecord.status === "joined") {
      sendMessage();
    } else if (channelRecord.status === "CHANNEL_ERROR" || channelRecord.status === "CLOSED") {
      cleanup();
      if (retryCount < 2) {
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