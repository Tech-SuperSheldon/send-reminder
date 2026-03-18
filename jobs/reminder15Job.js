const dayjs = require("dayjs");
const axios = require("axios");
const schedule = require("node-schedule");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");
const ReminderLog = require("../models/sessionReminderLog");
const { sendSagePilotTemplate } = require("../services/sagepilot");

/* ------------------ API HEADERS ------------------ */
const WISE_HEADERS = {
  Authorization: process.env.WISE_AUTHORIZATION,
  "Content-Type": "application/json",
  "x-api-key": process.env.WISE_API_KEY,
  "x-wise-namespace": process.env.WISE_NAMESPACE,
  "user-agent": `VendorIntegrations/${process.env.WISE_NAMESPACE}`,
};

/* ------------------ FETCH SESSION FROM API ------------------ */
async function fetchSessionFromAPI(sessionId) {
  try {
    const response = await axios.get(
      `https://api.wiseapp.live/user/session/${sessionId}?showLiveClassInsight=true&showFeedbackConfig=true&showFeedbackSubmission=true&showSessionFiles=true&showAgendaStructure=true`,
      { headers: WISE_HEADERS }
    );
    return response.data?.data;
  } catch (err) {
    console.error(`[Scheduler] ❌ Failed to fetch session from API`);
    console.error(`[Scheduler]    Session ID : ${sessionId}`);
    console.error(`[Scheduler]    URL        : https://api.wiseapp.live/user/session/${sessionId}`);
    console.error(`[Scheduler]    Status     : ${err.response?.status}`);
    console.error(`[Scheduler]    Response   : ${JSON.stringify(err.response?.data)}`);
    return null;
  }
}

/* ------------------ FETCH STUDENT CREDITS ------------------ */
async function fetchStudentCredits(classId, studentId) {
  try {
    const url = `https://api.wiseapp.live/institutes/6801059f6a1ee607782c56ff/classes/${classId}/students/${studentId}/sessionCredits?fetchHistory=true`;
    const response = await axios.get(url, { headers: WISE_HEADERS });
    const available = response.data?.data?.credits?.available;
    console.log(`[Scheduler]    💳 Credits for student ${studentId}: available = ${available}`);
    return available;
  } catch (err) {
    console.error(`[Scheduler]    ❌ Failed to fetch credits`);
    console.error(`[Scheduler]       Class ID   : ${classId}`);
    console.error(`[Scheduler]       Student ID : ${studentId}`);
    console.error(`[Scheduler]       Status     : ${err.response?.status}`);
    console.error(`[Scheduler]       Response   : ${JSON.stringify(err.response?.data)}`);
    return null;
  }
}

/* ------------------ MAIN HANDLER ------------------ */
async function handleSession15(session) {
  const subject = session.classSubject || "Class";

  console.log(`[Scheduler] 🔹 Processing Session: ${session._id} | Subject: ${subject}`);

  // 1. Fetch session from API first — if it fails, skip everything ✅
  const sessionData = await fetchSessionFromAPI(session._id);
  if (!sessionData) {
    console.log(`[Scheduler]    ⛔ Session ${session._id} not found in Wise API — skipping all reminders.`);
    return 0;
  }

  const wiseLink = sessionData?.join_url || sessionData?.joinUrl || "Not available";
  const wisePlatformLink = `https://supersheldon.wise.live/`;

  // 2. Fetch Students — OLD schema (classes._id) + NEW schema (classroom._id)
  const studentsOld = await User.find({
    relation: "STUDENT",
    status: "ACCEPTED",
    "classes._id": session.classId,
  }).populate("userId").lean();

  const studentsNew = await User.find({
    "classroom._id": session.classId,
  }).lean();

  const students = [...studentsOld, ...studentsNew];

  console.log(`[Scheduler]    Found ${students.length} students enrolled (old: ${studentsOld.length}, new: ${studentsNew.length}).`);

  // 3. Fetch Teacher
  const teacherDoc = await Teacher.findOne({
    "userId._id": session.userId?._id,
  }).lean();

  if (!teacherDoc) {
    console.log(`[Scheduler] ❌ Teacher not found for session ${session._id}`);
    return 0;
  }

  const teacherName = teacherDoc.userId?.name || "Teacher";
  const teacherPhone = String(teacherDoc.userId?.phoneNumber || "").replace(/\D/g, "");

  // 4. Format class time
  const classTimeReadable = new Date(session.scheduledStartTime).toLocaleString("en-AU", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  // ---------------------------------------------------------
  // 🔹 TEACHER REMINDER
  // ---------------------------------------------------------
  if (teacherPhone) {
    const studentNamesList = students
      .map(s => s.userId?.name || s.student?.name)
      .filter(Boolean)
      .join(", ");

    try {
      console.log(`[Scheduler]    ➡️ Sending SMS to Teacher (${teacherName})...`);
      await sendSagePilotTemplate({
        phone: teacherPhone,
        customerName: teacherName,
        templateName: "teacher_course_class_15min",
        bodyTexts: [teacherName, studentNamesList || "Students", subject],
      });
      console.log(`[Scheduler]    ✅ Teacher SMS Sent.`);
    } catch (err) {
      console.error(`[Scheduler]    ❌ Failed to send Teacher SMS:`, err.message);
    }
  } else {
    console.log(`[Scheduler]    ⚠️ No phone number for Teacher ${teacherName}`);
  }

  // ---------------------------------------------------------
  // 🔹 STUDENT REMINDERS
  // ---------------------------------------------------------
  for (const stu of students) {
    const studentName  = stu.userId?.name  || stu.student?.name  || "Student";
    const studentPhone = String(stu.userId?.phoneNumber || stu.student?.phoneNumber || "").replace(/\D/g, "");
    const studentEmail = stu.userId?.email || stu.student?.email || "";
    const studentId    = stu.userId?._id   || stu.student?._id;

    if (!studentPhone) {
      console.log(`[Scheduler]    ⚠️ Skipping student ${studentName} (No Phone)`);
      continue;
    }

    // Check available credits
    const availableCredits = await fetchStudentCredits(session.classId, studentId);
    if (availableCredits !== null && availableCredits <= 0) {
      console.log(`[Scheduler]    ⛔ Skipping student ${studentName} — 0 available credits.`);
      continue;
    }

    try {
      console.log(`[Scheduler]    ➡️ Sending SMS to Student (${studentName})...`);
      await sendSagePilotTemplate({
        phone: studentPhone,
        customerName: studentName,
        templateName: "before_course_class_15min_student_v1_v1_v2",
        bodyTexts: [
          studentName,      // 1
          subject,          // 2
          classTimeReadable,// 3
          wisePlatformLink, // 4
          studentEmail,     // 5
          studentName,      // 6
        ],
      });

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

  const rangeStart = new Date(now.getTime() + 15 * 60 * 1000);
  const rangeEnd   = new Date(now.getTime() + 16 * 60 * 1000);

  console.log(`[Scheduler] 🔎 Scanning for classes starting between: ${rangeStart.toISOString()} and ${rangeEnd.toISOString()}`);

  const sessions = await Session.find({
    scheduledStartTime: {
      $gte: rangeStart.toISOString(),
      $lt: rangeEnd.toISOString(),
    },
    meetingStatus: { $ne: "CANCELLED" },
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