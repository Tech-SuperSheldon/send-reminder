const mongoose = require("mongoose");

// Connect specifically to `pre-sales-crm` DB
const crmDb = mongoose.connection.useDb("pre-sales-crm");

const Reminder8hrLogSchema = new mongoose.Schema({
  sessionId: String,

  studentName: String,
  studentEmail: String,

  teacherName: String,
  teacherEmail: String,

  subject: String,
  classTime: String,

  channel: { type: String, default: "whatsapp" },
  templateName: String,

  status: { type: String, enum: ["SENT", "FAILED"], default: "SENT" },

  sentAt: { type: Date, default: Date.now },

  meta: {}, 
});

module.exports = crmDb.model("Reminder8hrLog", Reminder8hrLogSchema, "reminder_8hr_logs");
