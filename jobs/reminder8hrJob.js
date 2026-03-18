const axios = require("axios");
const schedule = require("node-schedule");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");
const Session8hrLog = require("../models/session8hrLog");
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
    console.error(`[Scheduler-8hr] ❌ Failed to fetch session from API`);
    console.error(`[Scheduler-8hr]    Session ID : ${sessionId}`);
    console.error(`[Scheduler-8hr]    URL        : https://api.wiseapp.live/user/session/${sessionId}`);
    console.error(`[Scheduler-8hr]    Status     : ${err.response?.status}`);
    console.error(`[Scheduler-8hr]    Response   : ${JSON.stringify(err.response?.data)}`);
    return null;
  }
}

/* ------------------ FETCH STUDENT CREDITS ------------------ */
async function fetchStudentCredits(classId, studentId) {
  try {
    const url = `https://api.wiseapp.live/institutes/6801059f6a1ee607782c56ff/classes/${classId}/students/${studentId}/sessionCredits?fetchHistory=true`;
    const response = await axios.get(url, { headers: WISE_HEADERS });
    const available = response.data?.data?.credits?.available;
    console.log(`[Scheduler-8hr]    💳 Credits for student ${studentId}: available = ${available}`);
    return available;
  } catch (err) {
    console.error(`[Scheduler-8hr]    ❌ Failed to fetch credits`);
    console.error(`[Scheduler-8hr]       Class ID   : ${classId}`);
    console.error(`[Scheduler-8hr]       Student ID : ${studentId}`);
    console.error(`[Scheduler-8hr]       Status     : ${err.response?.status}`);
    console.error(`[Scheduler-8hr]       Response   : ${JSON.stringify(err.response?.data)}`);
    return null;
  }
}

/* ------------------ TIMEZONE MAPPING ------------------ */
const COUNTRY_TZ_MAPPING = {
  "91": "Asia/Kolkata",
  "61": "Australia/Sydney",
  "1": "America/New_York",
  "44": "Europe/London",
  "971": "Asia/Dubai",
  "65": "Asia/Singapore"
};

function getStudentTimeZone(phone) {
  for (const [code, tz] of Object.entries(COUNTRY_TZ_MAPPING)) {
    if (phone.startsWith(code)) return tz;
  }
  return "Australia/Sydney";
}

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
    meetingStatus: { $ne: "CANCELLED" },
  }).lean();

  console.log(`[Scheduler-8hr] 🎯 Found ${sessions.length} sessions in window.`);

  for (const session of sessions) {
    const subject = session.classSubject || "";
    const startTime = new Date(session.scheduledStartTime);

    console.log(`[Scheduler-8hr] 🔹 Processing Session: ${session._id} | Subject: ${subject}`);

    // ✅ Check session exists in Wise API first — if not, skip all reminders
    const sessionData = await fetchSessionFromAPI(session._id);
    if (!sessionData) {
      console.log(`[Scheduler-8hr]    ⛔ Session ${session._id} not found in Wise API — skipping all reminders.`);
      continue; // skip to next session
    }

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
      const studentId = stu.userId?._id || stu._id;

      if (!phone) continue;

      // Check available credits
      const availableCredits = await fetchStudentCredits(session.classId, studentId);
      if (availableCredits !== null && availableCredits <= 0) {
        console.log(`[Scheduler-8hr]    ⛔ Skipping student ${studentName} — 0 available credits.`);
        continue;
      }

      const studentTimeZone = getStudentTimeZone(phone);
      const minus4 = new Date(startTime);
      minus4.setHours(minus4.getHours() - 4);

      const formatOptions = {
        timeZone: studentTimeZone,
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      };

      const classTimeReadable = startTime.toLocaleString("en-AU", formatOptions);
      const minus4TimeReadable = minus4.toLocaleString("en-AU", formatOptions);

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

      await Session8hrLog.create({
        sessionId: session._id,
        studentName,
        studentEmail,
        teacherName,
        subject,
        classTime: session.scheduledStartTime,
        status: "SENT",
      });

      console.log(`[Scheduler-8hr]    ✅ Student SMS Sent & Logged for ${studentName}.`);
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