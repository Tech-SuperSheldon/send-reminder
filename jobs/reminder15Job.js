const dayjs = require("dayjs");
const schedule = require("node-schedule");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");
const ReminderLog = require("../models/sessionReminderLog");
const { sendSagePilotTemplate } = require("../services/sagepilot");

/* ------------------ MAIN HANDLER ------------------ */
async function handleSession15(session) {
  const subject = session.classSubject || "Class";
  const sessionStart = new Date(session.scheduledStartTime);
  
  console.log(`[Scheduler] 🔹 Processing Session: ${session._id} | Subject: ${subject}`);

  // 1. Fetch Students
  const students = await User.find({
    relation: "STUDENT",
    status: "ACCEPTED",
    "classes._id": session.classId,
  })
    .populate("userId")
    .lean();

  console.log(`[Scheduler]    Found ${students.length} students enrolled.`);

  // 2. Fetch Teacher
  const teacherDoc = await Teacher.findOne({
    "userId._id": session.userId?._id,
  }).lean();

  if (!teacherDoc) {
    console.log(`[Scheduler] ❌ Teacher not found for session ${session._id}`);
    return 0;
  }

  const teacherName = teacherDoc.userId?.name || "Teacher";
  const teacherPhone = String(teacherDoc.userId?.phoneNumber || "").replace(/\D/g, "");

  // ---------------------------------------------------------
  // 🔹 TEACHER REMINDER (Send Immediately)
  // ---------------------------------------------------------
  if (teacherPhone) {
    const studentNamesList = students.map(s => s.userId?.name).filter(Boolean).join(", ");
    
    try {
      console.log(`[Scheduler]    ➡️ Sending SMS to Teacher (${teacherName})...`);
      await sendSagePilotTemplate({
        phone: teacherPhone,
        customerName: teacherName,
        templateName: "teacher_course_class_15min",
        bodyTexts: [teacherName, studentNamesList || "Students", subject] 
      });
      console.log(`[Scheduler]    ✅ Teacher SMS Sent.`);
    } catch (err) {
      console.error(`[Scheduler]    ❌ Failed to send Teacher SMS:`, err.message);
    }
  } else {
    console.log(`[Scheduler]    ⚠️ No phone number for Teacher ${teacherName}`);
  }

  // ---------------------------------------------------------
  // 🔹 STUDENT REMINDERS (Send Immediately)
  // ---------------------------------------------------------
  for (const stu of students) {
    const studentName = stu.userId?.name || "Student";
    const studentPhone = String(stu.userId?.phoneNumber || "").replace(/\D/g, "");

    if (!studentPhone) {
      console.log(`[Scheduler]    ⚠️ Skipping student ${studentName} (No Phone)`);
      continue;
    }

    try {
      console.log(`[Scheduler]    ➡️ Sending SMS to Student (${studentName})...`);
      await sendSagePilotTemplate({
        phone: studentPhone,
        customerName: studentName,
        templateName: "before_course_class_15min_student",
        bodyTexts: [studentName, subject],
      });

      // Log to DB
      await ReminderLog.create({
        sessionId: session._id,
        studentName,
        teacherName,
        subject,
        classTime: session.scheduledStartTime,
        reminderType: "15min",
        status: "SENT",
      });
      console.log(`[Scheduler]    ✅ Student SMS Sent & Logged.`);
    } catch (err) {
      console.error(`[Scheduler]    ❌ Failed to send Student SMS:`, err.message);
    }
  }

  return students.length;
}

/* ------------------ RUN EVERY MINUTE ------------------ */
async function runNowOnce15() {
  const now = new Date();

  // LOGIC: Look for classes starting between [Now + 15m] and [Now + 16m]
  // This creates a 1-minute window. Since the scheduler runs every minute, 
  // it will eventually catch every class exactly 15 mins before start.
  
  const rangeStart = new Date(now.getTime() + 15 * 60 * 1000); 
  const rangeEnd   = new Date(now.getTime() + 16 * 60 * 1000); 

  console.log(`[Scheduler] 🔎 Scanning for classes starting between: ${rangeStart.toISOString()} and ${rangeEnd.toISOString()}`);

  const sessions = await Session.find({
    scheduledStartTime: {
      $gte: rangeStart.toISOString(),
      $lt: rangeEnd.toISOString(),
    },
  }).lean();

  console.log(`[Scheduler] 🎯 Database found ${sessions.length} sessions matching this time window.`);

  let reminders = 0;
  for (const s of sessions) {
    reminders += await handleSession15(s);
  }

  return { totalSessions: sessions.length, reminders };
}

/* ------------------ SCHEDULER ------------------ */
function startScheduler() {
  schedule.scheduleJob("* * * * *", async () => {
    console.log("\n------------------------------------------------");
    console.log(`[Scheduler] ⏰ Triggered at ${new Date().toISOString()}`);
    await runNowOnce15();
  });

  console.log("[Scheduler] 🚀 Service Started (Running every 1 minute)");
}

module.exports = {
  startScheduler,
  runNowOnce15,
};

