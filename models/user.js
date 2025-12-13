// models/user.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    userId: Schema.Types.Mixed, // your n8n used userId._id and userId.phoneNumber
    name: String,
    phoneNumber: String,
    fullPhoneNumber: String,
    // any other fields
  },
  { collection: "users", strict: false }
);

module.exports = mongoose.model("User", UserSchema);
