const schedule = require("node-schedule");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");
const Session8hrLog = require("../models/session8hrLog");
const { sendSagePilotTemplate } = require("../services/sagepilot");

/* ------------------ TIME HELPERS ------------------ */
function roundToNearestHalfHour(date = new Date()) {
  const m = date.getMinutes();
  if (m < 15) date.setMinutes(0, 0, 0);
  else if (m < 45) date.setMinutes(30, 0, 0);
  else date.setHours(date.getHours() + 1, 0, 0, 0);
  return date;
}

/* ------------------ MAIN RUNNER ------------------ */
async function runNowOnce8hr() {
  const base = roundToNearestHalfHour(new Date());
  base.setHours(base.getHours() + 8);

  const windowStart = new Date(base);
  const windowEnd = new Date(base);
  windowEnd.setMinutes(windowEnd.getMinutes() + 29, 59, 999);

  const sessions = await Session.find({
    scheduledStartTime: {
      $gte: windowStart.toISOString(),
      $lte: windowEnd.toISOString(),
    },
  }).lean();

  for (const session of sessions) {
    const subject = session.classSubject || "";
    const startTime = new Date(session.scheduledStartTime);

    const teacherDoc = await Teacher.findOne({
      "userId._id": session.userId?._id,
    }).lean();

    const teacherName = teacherDoc?.userId?.name || "";

    const students = await User.find({
      relation: "STUDENT",
      status: "ACCEPTED",
      "classes._id": session.classId,
    })
      .populate("userId")
      .lean();

    for (const stu of students) {
      const studentName = stu.userId?.name || "";
      const studentEmail = stu.userId?.email || "";
      const phone = String(stu.userId?.phoneNumber || "").replace(/\D/g, "");

      if (!phone) continue;

      const minus4 = new Date(startTime);
      minus4.setHours(minus4.getHours() - 4);

      const classTimeReadable = startTime.toLocaleString("en-AU", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });

      const minus4TimeReadable = minus4.toLocaleString("en-AU", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });

      // 🔹 SEND SAGEPILOT (8HR STUDENT)
      await sendSagePilotTemplate({
        phone,
        customerName: studentName,
        templateName: "course_class_8hr_massage1",
        bodyTexts: [
          studentName,
          subject,
          classTimeReadable,
          teacherName,
          minus4TimeReadable,
        ],
      });

      // 🔹 SAVE LOG
      await Session8hrLog.create({
        sessionId: session._id,
        studentName,
        studentEmail,
        teacherName,
        subject,
        classTime: session.scheduledStartTime,
        status: "SENT",
      });
    }
  }

  return { sessions: sessions.length };
}

/* ------------------ SCHEDULER ------------------ */
function startScheduler() {
  schedule.scheduleJob("0,30 * * * *", async () => {
    console.log("[Scheduler-8hr] Triggered at", new Date().toISOString());
    await runNowOnce8hr();
  });

  console.log("[Scheduler-8hr] Started");
}

module.exports = {
  runNowOnce8hr,
  startScheduler,
};
