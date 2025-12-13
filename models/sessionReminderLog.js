const mongoose = require("mongoose");


const SessionReminderLogSchema = new mongoose.Schema({
sessionId: String,
studentName: String,
studentEmail: String,
studentCountry: String, 
teacherName: String,
teacherEmail: String,
subject: String,
classTime: String,
sentAt: { type: Date, default: Date.now },
});


const secondaryDb = mongoose.connection.useDb("pre-sales-crm");


module.exports = secondaryDb.model(
"SessionReminderLog",
SessionReminderLogSchema,
"reminder_15min_logs"
);