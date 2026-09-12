import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
console.log("Testing connection with URI:", uri ? uri.replace(/:([^:@]+)@/, ":****@") : "none");

try {
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
  console.log("Connected successfully! Host:", conn.connection.host);
  const masterDbName = process.env.MASTER_DB_NAME || "salesbuster_master";
  const masterDb = mongoose.connection.useDb(masterDbName);
  const orgs = await masterDb.collection("organizations").find({}, { projection: { name: 1, email: 1, tenantDbName: 1 } }).toArray();
  console.log(`Found ${orgs.length} organizations:`, orgs);
  await mongoose.disconnect();
} catch (err) {
  console.log("Connection result/error:", err.message);
}
