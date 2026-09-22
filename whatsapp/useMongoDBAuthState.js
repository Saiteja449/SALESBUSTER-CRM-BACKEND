import { initAuthCreds, BufferJSON, proto, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import pino from "pino";
import WhatsAppAuthState from "../models/WhatsAppAuthState.js";

// Per-session write queue to serialize concurrent writes and prevent race conditions / state corruption.
// During pairing or rapid key updates, creds.update and keys.set fire in quick succession.
// Chaining writes through a per-session promise queue ensures partial/inconsistent states are never persisted.
const writeQueues = new Map(); // sessionId -> Promise

const enqueueWrite = (sessionId, writeFn) => {
  const currentQueue = writeQueues.get(sessionId) || Promise.resolve();
  const nextQueue = currentQueue
    .then(() => writeFn())
    .catch((err) => {
      console.error(`[WhatsApp] Write queue error for ${sessionId}:`, err);
    });
  writeQueues.set(sessionId, nextQueue);
  return nextQueue;
};

/**
 * MongoDB-backed Authentication State for Baileys
 * 
 * Replaces useMultiFileAuthState to avoid file system corruption and locks.
 */
export const useMongoDBAuthState = async (sessionId, AuthStateModel = WhatsAppAuthState) => {
  const Model = AuthStateModel || WhatsAppAuthState;

  const writeData = (data, keyId) => {
    return enqueueWrite(sessionId, async () => {
      try {
        const jsonStr = JSON.stringify(data, BufferJSON.replacer);
        await Model.findOneAndUpdate(
          { sessionId, type: keyId === "creds" ? "creds" : "keys", keyId },
          { data: jsonStr },
          { upsert: true, returnDocument: 'after' }
        );
      } catch (error) {
        console.error(`[WhatsApp] Failed to write auth data for ${keyId}:`, error);
      }
    });
  };

  const readData = async (keyId) => {
    try {
      const doc = await Model.findOne({
        sessionId,
        type: keyId === "creds" ? "creds" : "keys",
        keyId,
      });
      if (doc && doc.data) {
        return JSON.parse(doc.data, BufferJSON.reviver);
      }
    } catch (error) {
      console.error(`[WhatsApp] Failed to read auth data for ${keyId}:`, error);
    }
    return null;
  };

  const removeData = (keyId) => {
    return enqueueWrite(sessionId, async () => {
      try {
        await Model.deleteOne({
          sessionId,
          type: keyId === "creds" ? "creds" : "keys",
          keyId,
        });
      } catch (error) {
        console.error(`[WhatsApp] Failed to remove auth data for ${keyId}:`, error);
      }
    });
  };

  let creds = await readData("creds");
  if (!creds) {
    creds = initAuthCreds();
    await writeData(creds, "creds");
  }

  const logger = pino({ level: "silent" });

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore({
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const keyId = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, keyId));
              } else {
                tasks.push(removeData(keyId));
              }
            }
          }
          await Promise.all(tasks);
        },
      }, logger),
    },
    saveCreds: () => {
      // saveCreds delegates to writeData, which is automatically serialized via enqueueWrite
      return writeData(creds, "creds");
    },
  };
};
