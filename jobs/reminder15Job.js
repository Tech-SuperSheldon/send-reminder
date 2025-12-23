const dayjs = require("dayjs");
const schedule = require("node-schedule");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");
const ReminderLog = require("../models/sessionReminderLog");
const { sendSagePilotTemplate } = require("../services/sagepilot");

/* ------------------ TIME HELPERS ------------------ */
function roundToNearestHalfHour(date = new Date()) {
  const m = date.getMinutes();
  if (m < 15) date.setMinutes(0, 0, 0);
  else if (m < 45) date.setMinutes(30, 0, 0);
  else date.setHours(date.getHours() + 1, 0, 0, 0);
  return date;
}

function scheduleSend(sendAt, fn) {
  const delay = sendAt.getTime() - Date.now();
  if (delay <= 0) return fn();
  setTimeout(fn, delay);
}

/* ------------------ MAIN HANDLER ------------------ */
async function handleSession15(session) {
  const subject = session.classSubject || "";
  const sessionStart = new Date(session.scheduledStartTime);

  const students = await User.find({
    relation: "STUDENT",
    status: "ACCEPTED",
    "classes._id": session.classId,
  })
    .populate("userId")
    .lean();

  const teacherDoc = await Teacher.findOne({
    "userId._id": session.userId?._id,
  }).lean();

  if (!students.length || !teacherDoc) return 0;

  const teacherName = teacherDoc.userId?.name || "";
  const teacherPhone = String(
    teacherDoc.userId?.phoneNumber || ""
  ).replace(/\D/g, "");

  const sendAt = new Date(sessionStart.getTime() - 15 * 60 * 1000);

  for (const stu of students) {
    scheduleSend(sendAt, async () => {
      const studentName = stu.userId?.name || "";
      const studentEmail = stu.userId?.email || "";
      const studentPhone = String(
        stu.userId?.phoneNumber || ""
      ).replace(/\D/g, "");

      if (!studentPhone) return;

      // 🔹 STUDENT 15-MIN
      await sendSagePilotTemplate({
        phone: studentPhone,
        customerName: studentName,
        templateName: "before_course_class_15min_student",
        bodyTexts: [studentName, subject],

      });

      // 🔹 TEACHER 15-MIN
      if (teacherPhone) {
        await sendSagePilotTemplate({
          phone: teacherPhone,
          customerName: teacherName,
          templateName: "before_course_class_15_mins_teachers",
          bodyTexts: [teacherName, studentName, subject]

        });
      }

      // 🔹 SAVE LOG
      await ReminderLog.create({
        sessionId: session._id,
        studentName,
        studentEmail,
        teacherName,
        subject,
        classTime: session.scheduledStartTime,
        reminderType: "15min",
        status: "SENT",
      });
    });
  }

  return students.length;
}

/* ------------------ RUN ONCE ------------------ */
async function runNowOnce15() {
  const rounded = roundToNearestHalfHour(new Date());
  const targetISO = rounded.toISOString();

  const sessions = await Session.find({
    scheduledStartTime: targetISO,
  }).lean();

  let reminders = 0;
  for (const s of sessions) reminders += await handleSession15(s);

  return { totalSessions: sessions.length, reminders };
}

/* ------------------ SCHEDULER ------------------ */
function startScheduler() {
  schedule.scheduleJob("*/30 * * * *", async () => {
    console.log("[Scheduler-15m] Triggered at", new Date().toISOString());
    await runNowOnce15();
  });

  console.log("[Scheduler-15m] Started");
}

module.exports = {
  startScheduler,
  runNowOnce15,
};
