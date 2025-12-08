// jobs/reminder15Job.js
const dayjs = require("dayjs");
const schedule = require("node-schedule");
const { makeClient, sendTemplate } = require("../services/interakt");
const Session = require("../models/session");
const User = require("../models/user");
const Teacher = require("../models/teacher");
const { sendEmail } = require("../services/email");

const SessionReminderLog = require("../models/sessionReminderLog");

/* ------------------------------------------------------------------
   ROUND TO NEAREST HALF HOUR
------------------------------------------------------------------ */
function roundToNearestHalfHour(date = new Date()) {
  const d = dayjs(date);
  const m = d.minute();

  if (m < 15) return d.minute(0).second(0).millisecond(0).toDate();
  if (m < 45) return d.minute(30).second(0).millisecond(0).toDate();
  return d.add(1, "hour").minute(0).second(0).millisecond(0).toDate();
}

/* ------------------------------------------------------------------
   FORMAT TIME FOR EMAIL / LOGS
------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------
   SAFE TIMER FOR DELAYED SEND
------------------------------------------------------------------ */
function scheduleSend(sendAtDate, fn) {
  const delay = sendAtDate.getTime() - Date.now();

  if (delay <= 0) return fn(); // send immediately if time passed
  setTimeout(fn, delay);
}

/* ------------------------------------------------------------------
   SAVE LOG HELPER
------------------------------------------------------------------ */
async function saveReminderLog({
  sessionId,
  studentName = "",
  studentEmail = "",
  teacherName = "",
  teacherEmail = "",
  subject = "",
  classTime = null,
  channel = "whatsapp",
  status = "SENT",
  extra = {},
}) {
  try {
    const doc = new SessionReminderLog({
      sessionId,
      studentName,
      studentEmail,
      teacherName,
      teacherEmail,
      subject,
      classTime: classTime ? new Date(classTime).toISOString() : undefined,
      channel,
      status,
      sentAt: new Date(),
      meta: extra,
    });
    await doc.save();
    return doc;
  } catch (err) {
    console.error("Failed to save reminder log:", err);
    return null;
  }
}

/* ------------------------------------------------------------------
   HANDLE A SINGLE SESSION
------------------------------------------------------------------ */
async function handleSession15(session) {
  const studentsArr = session.students || [];
  const classSubject = session.classSubject || session.classId?.subject || "";
  const teacherId = session.userId?._id || null;

  const client = makeClient(process.env.INTERAKT_AUTH);
  let teacher = null;

  // FETCH TEACHER DATA
  if (teacherId) {
    teacher = await Teacher.findOne({ "userId._id": teacherId }).lean();
  }

  const teacherName = teacher?.userId?.name || session.userId?.name || "";
  const teacherEmail = teacher?.userId?.email || "";

  // BUILD RECIPIENT LIST
  const recipients = [];

  // ---- STUDENT (first student only — same as before)
  if (studentsArr.length > 0) {
    const stuId = studentsArr[0];

    const stuDoc =
      (await User.findOne({ "userId._id": stuId }).lean()) ||
      (await User.findOne({ _id: stuId }).lean()) ||
      null;

    if (stuDoc) {
      recipients.push({
        relation: "STUDENT",
        id: stuId,
        name: stuDoc.userId?.name || stuDoc.name || "",
        phone: stuDoc.userId?.phoneNumber || "",
        email: stuDoc.userId?.email || "",
        subject: classSubject,
        student_name: "",
        sessionId: session._id,
        sessionStart: session.scheduledStartTime,
      });
    }
  }

  // ---- TEACHER
  if (teacher) {
    recipients.push({
      relation: "TEACHER",
      id: teacherId,
      name: teacherName,
      phone: teacher?.userId?.phoneNumber || "",
      email: teacherEmail,
      subject: classSubject,
      student_name: session.className || "",
      sessionId: session._id,
      sessionStart: session.scheduledStartTime,
    });
  }

  // WHEN TO SEND? → EXACTLY 15 MINUTES BEFORE SESSION
  const sessionStart = new Date(session.scheduledStartTime);
   const sendAt = new Date(sessionStart.getTime() - 15 * 60 * 1000);
  //const sendAt = new Date();

  // SCHEDULE SEND FOR EACH RECIPIENT
  for (const r of recipients) {
    scheduleSend(sendAt, async () => {
      try {
        console.log(
          `[SEND-15m] Sending → ${r.relation} ${r.name} (${
            r.id
          }) at ${new Date().toISOString()}`
        );

        const sessionStartReadable = formatReadable(r.sessionStart);
        const phone = String(r.phone || "").replace(/\D/g, "");

        /* ------------------------------
             SEND WHATSAPP
        ------------------------------ */
        if (phone) {
          try {
            if (r.relation === "STUDENT") {
              const waResp = await sendTemplate(client, {
                fullPhoneNumber: phone,
                type: "Template",
                template: {
                  name: "before_course_class_15min_student_",
                  languageCode: "en",
                  bodyValues: [r.name, r.subject],
                },
                callbackData: JSON.stringify({
                  sessionId: r.sessionId,
                  template_name: "before_course_class_15min_student_",
                }),
              });

              console.log("[WA-15m] Student message sent →", phone);

              // Save log (whatsapp)
              await saveReminderLog({
                sessionId: r.sessionId,
                studentName: r.name,
                studentEmail: r.email || "",
                teacherName,
                teacherEmail,
                subject: r.subject || "",
                classTime: r.sessionStart,
                channel: "whatsapp",
                status: "SENT",
                extra: { providerResponse: waResp },
              });
            } else {
              const waResp = await sendTemplate(client, {
                fullPhoneNumber: phone,
                type: "Template",
                template: {
                  name: "before_course_class_15mins_teachers_tv",
                  languageCode: "en",
                  bodyValues: [r.name, r.student_name, r.subject],
                },
                callbackData: JSON.stringify({
                  sessionId: r.sessionId,
                  template_name: "before_course_class_15mins_teachers_tv",
                }),
              });

              console.log("[WA-15m] Teacher message sent →", phone);

              // Save log (whatsapp teacher)
              await saveReminderLog({
                sessionId: r.sessionId,
                studentName: r.student_name || "",
                studentEmail: "",
                teacherName: r.name,
                teacherEmail,
                subject: r.subject || "",
                classTime: r.sessionStart,
                channel: "whatsapp",
                status: "SENT",
                extra: { providerResponse: waResp },
              });
            }
          } catch (err) {
            console.error("WA send error (15m):", err?.message || err);

            // Log WA failure
            await saveReminderLog({
              sessionId: r.sessionId,
              studentName:
                r.relation === "STUDENT" ? r.name : r.student_name || "",
              studentEmail: r.email || "",
              teacherName,
              teacherEmail,
              subject: r.subject || "",
              classTime: r.sessionStart,
              channel: "whatsapp",
              status: "FAILED",
              extra: {
                error: err?.response?.data || err?.message || String(err),
              },
            });
          }
        }

        /* ------------------------------
             SEND EMAIL
        ------------------------------ */
        if (r.email) {
          try {
            if (r.relation === "STUDENT") {
              const html = `
                <h2>Hi ${r.name},</h2>
                <p>Your <strong>${r.subject}</strong> class will start soon.</p>
                <p><b>Start Time:</b> ${sessionStartReadable}</p>
                <p>Regards,<br/>SuperSheldon Team</p>
              `;
              const emailResp = await sendEmail(
                r.email,
                "Reminder: Your class starts in 15 minutes",
                html
              );

              console.log("[Email-15m] Student email sent →", r.email);

              await saveReminderLog({
                sessionId: r.sessionId,
                studentName: r.name,
                studentEmail: r.email,
                teacherName,
                teacherEmail,
                subject: r.subject || "",
                classTime: r.sessionStart,
                channel: "email",
                status: "SENT",
                extra: { providerResponse: emailResp },
              });
            } else {
              const html = `
                <h2>Hello ${r.name},</h2>
                <p>This is a reminder for your upcoming class.</p>
                <p><b>Student:</b> ${r.student_name}</p>
                <p><b>Subject:</b> ${r.subject}</p>
                <p><b>Start Time:</b> ${sessionStartReadable}</p>
                <p>Regards,<br/>SuperSheldon Team</p>
              `;
              const emailResp = await sendEmail(
                r.email,
                "Reminder: Your teaching session starts in 15 minutes",
                html
              );

              console.log("[Email-15m] Teacher email sent →", r.email);

              await saveReminderLog({
                sessionId: r.sessionId,
                studentName: r.student_name || "",
                studentEmail: "",
                teacherName: r.name,
                teacherEmail: r.email,
                subject: r.subject || "",
                classTime: r.sessionStart,
                channel: "email",
                status: "SENT",
                extra: { providerResponse: emailResp },
              });
            }
          } catch (err) {
            console.error("Email send error (15m):", {
              message: err.message,
              responseData: err.response?.data || null,
              stack: err.stack,
            });

            await saveReminderLog({
              sessionId: r.sessionId,
              studentName:
                r.relation === "STUDENT" ? r.name : r.student_name || "",
              studentEmail: r.email || "",
              teacherName,
              teacherEmail,
              subject: r.subject || "",
              classTime: r.sessionStart,
              channel: "email",
              status: "FAILED",
              extra: {
                error: err?.response?.data || err?.message || String(err),
              },
            });
          }
        }
      } catch (err) {
        console.error("Send error (15m):", {
          message: err.message,
          responseData: err.response?.data || null,
          stack: err.stack,
        });
      }
    });
  }

  return recipients.length;
}

/* ------------------------------------------------------------------
   RUN NOW LOGIC (corrected to find sessions 30 min ahead)
------------------------------------------------------------------ */
async function runNowOnce15() {
  try {
    const now = new Date();

    // Round to nearest :00 or :30
    const rounded = roundToNearestHalfHour(now);

    // Find sessions EXACTLY 30 minutes later
    const targetTime = new Date(rounded.getTime() + 30 * 60 * 1000);
    const targetISO = targetTime.toISOString();

    console.log("[runNowOnce-15m] Looking for sessions at:", targetISO);

    const sessions = await Session.find({
      scheduledStartTime: targetISO,
    }).lean();

    console.log("[runNowOnce-15m] Found sessions:", sessions.length);

    let total = 0;
    for (const s of sessions) {
      total += await handleSession15(s);
    }

    return { totalSessions: sessions.length, reminders: total };
  } catch (err) {
    console.error("[15m] Job Failed:", err);
    throw err;
  }
}

/* ------------------------------------------------------------------
   30-MINUTE SCHEDULER
------------------------------------------------------------------ */
function startScheduler() {
  schedule.scheduleJob("*/30 * * * *", async () => {
    console.log("[15m Scheduler] Triggered:", new Date().toISOString());
    await runNowOnce15();
  });

  console.log("[15m Scheduler] Running every 30 mins");
}

module.exports = { startScheduler, runNowOnce15 };
