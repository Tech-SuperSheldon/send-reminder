const schedule = require("node-schedule");
const dayjs = require("dayjs");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");


const Reminder8hrLog = require("../models/session8hrLog");

const axios = require("axios");

const INTERAKT_ENDPOINT = process.env.INTERAKT_ENDPOINT;
const INTERAKT_AUTH = process.env.INTERAKT_AUTH;

// Round to nearest 30 mins
function roundToNearestHalfHour(date = new Date()) {
  const d = new Date(date);
  const m = d.getMinutes();
  if (m < 15) d.setMinutes(0, 0, 0);
  else if (m < 45) d.setMinutes(30, 0, 0);
  else d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

// 📩 Send message to Interakt
async function sendInteraktMessage(target) {
  if (!INTERAKT_ENDPOINT || !INTERAKT_AUTH) {
    console.warn("Interakt config missing, skipping send.");
    return { error: "Missing Interakt config" };
  }

  const payload = {
    fullPhoneNumber: target.fullPhoneNumber,
    type: "Template",
    callbackData: JSON.stringify({
      student_name: target.name,
      student_phone: target.fullPhoneNumber,
      teacher_name: target.teacher,
      subject: target.subject,
      reminder_time: target.reminderTime,
    }),
    template: {
      name: "before_course_class_to_confirm_joining_8hr_student_8s",
      languageCode: "en",
      bodyValues: [
        target.name,
        target.subject,
        target.sessionStartReadable,
        target.teacher,
        target.reminderTimeReadable,
      ],
    },
  };

  try {
    const res = await axios.post(INTERAKT_ENDPOINT, payload, {
      headers: {
        Authorization: INTERAKT_AUTH,
        "Content-Type": "application/json",
      },
    });

    console.log("Interakt-8hr success:", res.status);
    return { success: true, response: res.data };
  } catch (e) {
    const errData = e.response?.data || e.message;
    console.error("Interakt-8hr error:", errData);
    return { success: false, error: errData };
  }
}

// MAIN: run once for 8hr reminders
async function runNowOnce8hr() {
  const resultArray = [];
  let sessionCount = 0;

  try {
    const base = roundToNearestHalfHour(new Date());
    base.setHours(base.getHours() + 8);

    const startWindow = new Date(base);
    const endWindow = new Date(base);
    endWindow.setMinutes(endWindow.getMinutes() + 29);

    const sessions = await Session.find({
      scheduledStartTime: {
        $gte: startWindow.toISOString(),
        $lte: endWindow.toISOString(),
      },
    })
      .populate("userId")
      .lean();

    sessionCount = sessions.length;
    if (!sessions.length) return { resultArray, sessionCount };

    for (const session of sessions) {
      const classId = session.classId;
      const subject = session.classSubject || "";

      //  Fetch teacher
      const teacherDoc = await Teacher.findOne(
        { "userId._id": String(session.userId?._id) },
        { "userId.email": 1, "userId.name": 1 }
      ).lean();

      const teacherName = teacherDoc?.userId?.name || "";
      const teacherEmail = teacherDoc?.userId?.email || "";

      const students = await User.find({
        relation: "STUDENT",
        status: "ACCEPTED",
        classes: { $elemMatch: { _id: classId } },
      })
        .populate("userId")
        .lean();

      const startTime = new Date(session.scheduledStartTime);
      const reminderDate = new Date(startTime);
      reminderDate.setHours(reminderDate.getHours() - 4);

      for (const stu of students) {
        const studentName = stu.userId?.name || stu.name || "";
        const studentEmail = stu.userId?.email || "";
        const phone = (stu.userId?.phoneNumber || "").replace(/\D/g, "");

        if (!phone) continue;

        const target = {
          name: studentName,
          fullPhoneNumber: phone,
          subject,
          teacher: teacherName,
          sessionStartReadable: startTime.toLocaleString("en-US", {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }),
          reminderTime: reminderDate.toISOString(),
          reminderTimeReadable: reminderDate.toLocaleString("en-US", {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }),
        };

        //  Send WhatsApp message
        const sendResult = await sendInteraktMessage(target);

        // Save log to pre-sales-crm.reminder_8hr_logs
        await Reminder8hrLog.create({
          sessionId: session._id,

          studentName,
          studentEmail,

          teacherName,
          teacherEmail,

          subject,
          classTime: session.scheduledStartTime,

          channel: "whatsapp",
          templateName: "before_course_class_to_confirm_joining_8hr_student_8s",

          status: sendResult.success ? "SENT" : "FAILED",
          meta: sendResult.success
            ? sendResult.response
            : { error: sendResult.error },
        });

        resultArray.push({
          studentName,
          studentEmail,
          teacherName,
          teacherEmail,
          subject,
        });
      }
    }

    return { resultArray, sessionCount };
  } catch (err) {
    console.error("runNowOnce8hr failed:", err);
    return { resultArray, sessionCount };
  }
}

// Scheduler
function startScheduler() {
  const cron = "0,30 * * * *";
  console.log("[Scheduler-8hr] 8hr Scheduler activated:", cron);
  schedule.scheduleJob(cron, runNowOnce8hr);
}

module.exports = {
  runNowOnce8hr,
  startScheduler,
  _roundToNearestHalfHour: roundToNearestHalfHour,
};
