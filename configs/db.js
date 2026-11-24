import mongoose from "mongoose";

const connectDB = async () => {
  try {
    mongoose.connection.on("error", (err) => {
      console.error(`Mongoose connection error: ${err.message}`);
    });

    mongoose.connection.on("disconnected", () => {
      console.log("Mongoose connection is disconnected");
    });

    process.on("SIGINT", async () => {
      await mongoose.connection.close();
      console.log("Mongoose connection closed due to application termination");
      process.exit(0);
    });

    const dbUri =
      process.env.NODE_ENV === "production"
        ? process.env.MONGODB_URI || process.env.MONGODB_URI_BETA
        : process.env.MONGODB_URI_BETA || process.env.MONGODB_URI;

    if (!dbUri) {
      throw new Error("MongoDB connection URI is not defined in environment variables.");
    }

    const conn = await mongoose.connect(dbUri, {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Clean up any legacy empty-string email duplicates and sync partial index
    try {
      const masterDbName = process.env.MASTER_DB_NAME || "salesbuster_master";
      const masterDb = conn.connection.useDb(masterDbName);
      const authUsersColl = masterDb.collection("authusers");

      const updateResult = await authUsersColl.updateMany(
        { email: "" },
        { $unset: { email: "" } }
      );
      if (updateResult.modifiedCount > 0) {
        console.log(`[DB Init] Unset ${updateResult.modifiedCount} legacy empty-string emails in authusers.`);
      }

      const indexes = await authUsersColl.indexes();
      const emailIdx = indexes.find((idx) => idx.name === "email_1");
      if (emailIdx && !emailIdx.partialFilterExpression) {
        console.log("[DB Init] Replacing legacy email_1 index with partialFilterExpression...");
        await authUsersColl.dropIndex("email_1");
        await authUsersColl.createIndex(
          { email: 1 },
          {
            unique: true,
            partialFilterExpression: {
              email: { $exists: true, $type: "string", $gt: "" },
            },
          }
        );
        console.log("[DB Init] email_1 partial unique index active.");
      }
    } catch (idxErr) {
      console.warn("[DB Init] Index verification notice:", idxErr.message);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
