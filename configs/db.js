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

    const configuredUri =
      process.env.MONGODB_URI_BETA ||
      process.env.MONGODB_URI ||
      process.env.MONGO_URI;

    if (!configuredUri) {
      console.warn(
        "\n⚠️  [MongoDB Warning] No MONGODB_URI or MONGODB_URI_BETA detected in .env file." +
        "\n   Attempting local fallback to: mongodb://127.0.0.1:27017/salesbuster\n"
      );
    }

    const dbUri = configuredUri || "mongodb://127.0.0.1:27017/salesbuster";
    const conn = await mongoose.connect(dbUri);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
