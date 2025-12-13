// db.js
const mongoose = require("mongoose");
const { MONGODB_URI } = process.env;

async function connect() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI not set in .env");
  await mongoose.connect(MONGODB_URI, { dbName: "WiseLMS" });
  console.log("MongoDB connected");
}

module.exports = { connect, mongoose };
