// jobs/reminder15Job.js
const dayjs = require("dayjs");
const schedule = require("node-schedule");
const { makeClient, sendTemplate } = require("../services/interakt");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");
const SessionReminderLog = require("../models/sessionReminderLog");

const { parsePhoneNumberFromString } = require("libphonenumber-js");
const countries = require("i18n-iso-countries");
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));

const STATIC_COUNTRY_MAP = { "1": "United States/Canada", "44": "United Kingdom", "61": "Australia", "91": "India", "971": "UAE" };
const COUNTRY_CACHE = {};

const INTERAKT_CAMPAIGN_15M = process.env.INTERAKT_CAMPAIGN_15M || null;

/* UTIL FUNCTIONS */
function roundToNearestHalfHour(date = new Date()) {
  const d = dayjs(date);
  const m = d.minute();
  if (m < 15) return d.minute(0).second(0).millisecond(0).toDate();
  if (m < 45) return d.minute(30).second(0).millisecond(0).toDate();
  return d.add(1, "hour").minute(0).second(0).millisecond(0).toDate();
}

function formatReadable(dt) {
  return new Date(dt).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function getCountryFromLibPhone(rawPhone) {
  if (!rawPhone) return "Unknown";
  const trimmed = String(rawPhone).trim();
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (!digitsOnly) return "Unknown";

  for (let len = 1; len <= 3 && len <= digitsOnly.length; len++) {
    const prefix = digitsOnly.substring(0, len);
    if (COUNTRY_CACHE[prefix]) return COUNTRY_CACHE[prefix];
    if (STATIC_COUNTRY_MAP[prefix]) return STATIC_COUNTRY_MAP[prefix];
  }

  try {
    const pn = parsePhoneNumberFromString(trimmed);
    if (!pn || !pn.country) return "Unknown";

    const iso = pn.country;
    const countryName = countries.getName(iso, "en") || iso;

    const callingCode = pn.countryCallingCode;
    if (callingCode) COUNTRY_CACHE[callingCode] = countryName;

    return countryName;
  } catch {
    return "Unknown";
  }
}

function scheduleSend(sendAtDate, fn) {
  const delay = sendAtDate.getTime() - Date.now();
  if (delay <= 0) return fn();
  setTimeout(fn, delay);
}

/* MAIN JOB FUNCTION */
async function handleSession15(session) {
  const classSubject = session.classSubject || "";
  const client = makeClient(process.env.INTERAKT_AUTH);

  /* FETCH STUDENTS */
  const students = await User.find({
    relation: "STUDENT",
    status: "ACCEPTED",
    "classes._id": session.classId,
  })
    .populate("userId")
    .lean();

  /* FETCH TEACHER */
  const teacherId = session.userId?._id;
  const teacher = teacherId
    ? await Teacher.findOne({ "userId._id": teacherId }).lean()
    : null;

  const teacherName = teacher?.userId?.name || session.userId?.name || "";
  const teacherEmail = teacher?.userId?.email || "";
  const teacherPhone = teacher?.userId?.phoneNumber || "";

  const recipients = [];

  /* ADD STUDENTS */
  for (const stu of students) {
    recipients.push({
      relation: "STUDENT",
      id: stu._id,
      name: stu.userId?.name,
      phone: stu.userId?.phoneNumber,
      email: stu.userId?.email,
      subject: classSubject,
      student_name: stu.userId?.name,
      student_phone: stu.userId?.phoneNumber,
      sessionId: session._id,
      sessionStart: session.scheduledStartTime,
    });
  }

  /* ADD TEACHER */
  recipients.push({
    relation: "TEACHER",
    id: teacherId,
    name: teacherName,
    phone: teacherPhone,
    email: teacherEmail,
    student_name: students[0]?.userId?.name || "",
    student_phone: students[0]?.userId?.phoneNumber || "",
    subject: classSubject,
    sessionId: session._id,
    sessionStart: session.scheduledStartTime,
  });

  /* SEND TIME */
  const sendAt = new Date(new Date(session.scheduledStartTime).getTime() - 15 * 60 * 1000);

  /* LOOP THROUGH RECIPIENTS */
  for (const r of recipients) {
    scheduleSend(sendAt, async () => {
      try {
        console.log(`[SEND-15m] → ${r.relation}: ${r.name}`);

        const phone = String(r.phone || "").replace(/\D/g, "");
        const country = getCountryFromLibPhone(r.phone);
        let templateName = "";

        if (phone) {
          /* SEND STUDENT MESSAGE */
          if (r.relation === "STUDENT") {
            templateName = "before_course_class_15min_student_";
            const payload = {
              fullPhoneNumber: phone,
              type: "Template",
              template: {
                name: templateName,
                languageCode: "en",
                bodyValues: [r.name, r.subject],
              },
              callbackData: JSON.stringify({
                sessionId: r.sessionId,
                template_name: "before_course_class_15min_student_reply",
                student_name: r.name,
                student_phone: phone,
                teacher_name: teacherName,
                teacher_phone: teacherPhone,
                subject: r.subject,
              }),
            };

            if (INTERAKT_CAMPAIGN_15M) payload.campaignId = INTERAKT_CAMPAIGN_15M;

            await sendTemplate(client, payload);
            console.log(`📤 Student WA sent → ${phone}`);
          }

          /* SEND TEACHER MESSAGE */
          if (r.relation === "TEACHER") {
            templateName = "before_course_class_15mins_teachers_tv";
            const payload = {
              fullPhoneNumber: phone,
              type: "Template",
              template: {
                name: templateName,
                languageCode: "en",
                bodyValues: [r.name, r.student_name, r.subject],
              },
              callbackData: JSON.stringify({
                sessionId: r.sessionId,
                template_name: templateName,
                teacher_name: r.name,
                teacher_phone: phone,
                student_name: r.student_name,
                student_phone: r.student_phone,
                subject: r.subject,
              }),
            };

            if (INTERAKT_CAMPAIGN_15M) payload.campaignId = INTERAKT_CAMPAIGN_15M;

            await sendTemplate(client, payload);
            console.log(`📤 Teacher WA sent → ${phone}`);
          }

          /* SAVE LOG */
          if (templateName) {
            await SessionReminderLog.create({
              sessionId: r.sessionId,
              studentName: r.student_name,
              studentPhone: r.student_phone,
              teacherName: teacherName,
              teacherPhone: teacherPhone,
              subject: r.subject,
              classTime: r.sessionStart,
              reminderType: "15min",
              channel: "whatsapp",
              recipientRelation: r.relation,
              recipientName: r.name,
              recipientPhone: phone,
              templateName: templateName,
              status: "SENT",
              sentAt: new Date(),
            });
          }
        }

      } catch (err) {
        console.error("❌ Send error:", err);
        /* SAVE ERROR LOG */
        await SessionReminderLog.create({
          sessionId: r.sessionId,
          recipientName: r.name,
          reminderType: "15min",
          status: "FAILED",
          meta: { error: err.message }
        }).catch(e => console.error("Log failed:", e));
      }
    });
  }

  return recipients.length;
}

/* FIND SESSIONS AND RUN JOB */
async function runNowOnce15() {
  const now = new Date();
  const rounded = roundToNearestHalfHour(now);
  const target = new Date(rounded.getTime() + 30 * 60 * 1000).toISOString();

  const sessions = await Session.find({ scheduledStartTime: target }).lean();

  let total = 0;
  for (const s of sessions) total += await handleSession15(s);

  return { totalSessions: sessions.length, reminders: total };
}

function startScheduler() {
  schedule.scheduleJob("*/30 * * * *", async () => {
    console.log("[15m Scheduler] Triggered");
    await runNowOnce15();
  });

  console.log("[15m Scheduler] Running every 30 minutes");
}

module.exports = { startScheduler, runNowOnce15 };