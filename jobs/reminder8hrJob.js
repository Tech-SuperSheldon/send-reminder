const dayjs = require("dayjs");
const schedule = require("node-schedule");
const { makeClient, sendTemplate } = require("../services/interakt");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");
const Reminder8hrLog = require("../models/session8hrLog");

const { parsePhoneNumberFromString } = require("libphonenumber-js");
const countries = require("i18n-iso-countries");
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));

const INTERAKT_CAMPAIGN_8HR = process.env.INTERAKT_CAMPAIGN_8HR || null;

// --- UTILS & CONFIG ---

const STATIC_COUNTRY_MAP = {
  "1": "United States/Canada", "44": "United Kingdom",
  "61": "Australia", "91": "India", "971": "UAE"
};
const COUNTRY_CACHE = {};

// Rounds time to nearest XX:00 or XX:30
function roundToNearestHalfHour(date = new Date()) {
  const d = new Date(date);
  const m = d.getMinutes();
  if (m < 15) d.setMinutes(0, 0, 0);
  else if (m < 45) d.setMinutes(30, 0, 0);
  else d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

function formatReadable(dt) {
  return new Date(dt).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function getCountryFromLibPhone(rawPhone) {
  if (!rawPhone) return "Unknown";
  const trimmed = String(rawPhone).trim().replace(/\D/g, "");
  if (!trimmed) return "Unknown";

  // Check cache/static map first
  for (let len = 1; len <= 3 && len <= trimmed.length; len++) {
    const prefix = trimmed.substring(0, len);
    if (COUNTRY_CACHE[prefix]) return COUNTRY_CACHE[prefix];
    if (STATIC_COUNTRY_MAP[prefix]) return STATIC_COUNTRY_MAP[prefix];
  }

  // Parse using libphonenumber
  try {
    const pn = parsePhoneNumberFromString(trimmed);
    if (!pn) return "Unknown";
    const name = countries.getName(pn.country, "en") || pn.country;
    if (pn.countryCallingCode) COUNTRY_CACHE[pn.countryCallingCode] = name;
    return name;
  } catch {
    return "Unknown";
  }
}

// Delays execution until 'sendAtDate'
function scheduleSend(sendAtDate, fn) {
  const delay = sendAtDate.getTime() - Date.now();
  if (delay <= 0) return fn(); // Send immediately if time passed
  setTimeout(fn, delay);
}

// --- MAIN LOGIC ---

// Handles a single session: schedules/sends WA to students
async function handleSession8(session) {
  const classSubject = session.classSubject || "";
  const client = makeClient(process.env.INTERAKT_AUTH);

  // Fetch accepted students
  const students = await User.find({
    relation: "STUDENT", status: "ACCEPTED", "classes._id": session.classId,
  }).populate("userId").lean();

  // Fetch teacher details (for payload only)
  const teacherId = session.userId?._id;
  const teacherDoc = teacherId ? await Teacher.findOne({ "userId._id": teacherId }).lean() : null;
  const teacherName = teacherDoc?.userId?.name || session.userId?.name || "";
  const teacherPhone = teacherDoc?.userId?.phoneNumber || "";

  if (!students?.length) {
    console.log(`[8hr] No students for session ${session._id}`);
    return 0;
  }

  // Target send time: 8 hours before session
  const sessionStart = new Date(session.scheduledStartTime);
  const sendAt = new Date(sessionStart.getTime() - 8 * 60 * 60 * 1000);

  for (const stu of students) {
    scheduleSend(sendAt, async () => {
      try {
        const studentName = stu.userId?.name || stu.name || "";
        const phone = String(stu.userId?.phoneNumber || "").replace(/\D/g, "");

        if (!phone) {
          console.log(`[8hr] Skip ${studentName}: No phone`);
          return;
        }

        const payload = {
          fullPhoneNumber: phone,
          type: "Template",
          template: {
            name: "before_course_class_to_confirm_joining_8hr_student_8s",
            languageCode: "en",
            bodyValues: [studentName, classSubject, formatReadable(sessionStart), teacherName, formatReadable(sendAt)],
          },
          callbackData: JSON.stringify({
            sessionId: String(session._id),
            student_name: studentName,
            student_phone: phone,
            teacher_name: teacherName,
            teacher_phone: teacherPhone,
            subject: classSubject,
          }),
        };

        if (INTERAKT_CAMPAIGN_8HR) payload.campaignId = INTERAKT_CAMPAIGN_8HR;

        await sendTemplate(client, payload);
        console.log(`[8hr] WA sent -> ${phone}`);

        await Reminder8hrLog.create({
          sessionId: session._id,
          studentName,
          studentEmail: stu.userId?.email,
          studentCountry: getCountryFromLibPhone(phone),
          teacherName,
          subject: classSubject,
          classTime: session.scheduledStartTime,
          channel: "whatsapp",
          status: "SENT",
        });

      } catch (err) {
        console.error("[8hr] Send error:", err);
        // Log failure
        await Reminder8hrLog.create({
          sessionId: session._id,
          studentName: stu.userId?.name,
          classTime: session.scheduledStartTime,
          status: "FAILED",
          meta: { error: err.message },
        }).catch(e => console.error("Log failed:", e));
      }
    });
  }

  return students.length;
}

// Job Trigger: Finds sessions in a +/- 15m window
async function runNowOnce8hr() {
  const now = new Date();
  
  // 1. Anchor: current nearest half-hour
  const roundedNow = roundToNearestHalfHour(now);

  // 2. Target: Anchor + 8 hours
  const centerTarget = dayjs(roundedNow).add(8, 'hour');

  // 3. Window: +/- 15m around target (prevents missing irregular times)
  const windowStart = centerTarget.subtract(15, 'minute').toDate();
  const windowEnd = centerTarget.add(15, 'minute').toDate();

  console.log(`[8hr] Checking window: ${windowStart.toISOString()} - ${windowEnd.toISOString()}`);

  // 4. Find sessions in window
  const sessions = await Session.find({
    scheduledStartTime: { $gte: windowStart, $lt: windowEnd }
  }).lean();

  console.log(`[8hr] Sessions found: ${sessions.length}`);

  let total = 0;
  for (const s of sessions) total += await handleSession8(s);

  return { totalSessions: sessions.length, reminders: total };
}

function startScheduler() {
  // Run every 30 mins (XX:00, XX:30)
  const cron = "0,30 * * * *";
  console.log("[Scheduler-8hr] Started with cron:", cron);
  schedule.scheduleJob(cron, runNowOnce8hr);
}

module.exports = { startScheduler, runNowOnce8hr, _roundToNearestHalfHour: roundToNearestHalfHour };