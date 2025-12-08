// models/session.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const SessionSchema = new Schema(
  {
    scheduledStartTime: { type: String }, // you used ISO strings in n8n
    classId: {
      subject: String,
      // add other fields as needed
    },
    students: [Schema.Types.Mixed], // store ids as strings or ObjectId depending on your DB
    userId: Schema.Types.Mixed, // teacher info (may contain name)
  },
  { collection: "sessions", strict: false }
);

module.exports = mongoose.model("Session", SessionSchema);
