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
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
