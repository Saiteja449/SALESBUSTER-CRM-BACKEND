import { initAuthCreds, BufferJSON, proto, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import pino from "pino";
import WhatsAppAuthState from "../models/WhatsAppAuthState.js";

/**
 * MongoDB-backed Authentication State for Baileys
 * 
 * Replaces useMultiFileAuthState to avoid file system corruption and locks.
 */
export const useMongoDBAuthState = async (sessionId) => {
  const writeData = async (data, keyId) => {
    try {
      const jsonStr = JSON.stringify(data, BufferJSON.replacer);
      await WhatsAppAuthState.findOneAndUpdate(
        { sessionId, type: keyId === "creds" ? "creds" : "keys", keyId },
        { data: jsonStr },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (error) {
      console.error(`[WhatsApp] Failed to write auth data for ${keyId}:`, error);
    }
  };

  const readData = async (keyId) => {
    try {
      const doc = await WhatsAppAuthState.findOne({
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

  const removeData = async (keyId) => {
    try {
      await WhatsAppAuthState.deleteOne({
        sessionId,
        type: keyId === "creds" ? "creds" : "keys",
        keyId,
      });
    } catch (error) {
      console.error(`[WhatsApp] Failed to remove auth data for ${keyId}:`, error);
    }
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
      return writeData(creds, "creds");
    },
  };
};
