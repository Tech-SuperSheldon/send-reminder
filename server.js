require("dotenv").config();
const express = require("express");
const { connect, mongoose } = require("./db");
const axios = require("axios");
const reminder15 = require("./jobs/reminder15Job");
const reminder8hr = require("./jobs/reminder8hrJob");
const Session = require("./models/session");
const cors = require("cors");
const Session8hrLog = require("./models/session8hrLog");
const ReminderLog = require("./models/sessionReminderLog");
const app = express();
app.use(express.json());
const FRONTEND_URL = "http://localhost:5173";
const Teacher = require("./models/teacher");
const User = require("./models/user");
const { makeClient, sendTemplate } = require("./services/interakt");

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);
// ------------- Manual triggers -------------
// 15-min reminder manual run
app.post("/run-once", async (req, res) => {
  try {
    const data = await reminder15.runNowOnce15();

    return res.json({
      ok: true,
      job: "15min",
      totalSessions: data.totalSessions,
      reminders: data.reminders,
    });
  } catch (err) {
    console.error("run-once (15min) error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});


// 8-hr reminder manual run
app.post("/run-now", async (req, res) => {
  try {
    const data = await reminder8hr.runNowOnce8hr();

    return res.json({
      ok: true,
      job: "8hr",
      totalSessions: data.totalSessions,
      reminders: data.reminders,
    });
  } catch (err) {
    console.error("run-now (8hr) error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});


app.get("/reminder-logs", async (req, res) => {
  try {
    const logs = await ReminderLog.find().sort({ sentAt: -1 }).lean();
    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/8hr-logs", async (req, res) => {
  try {
    const logs = await Session8hrLog.find().sort({ sentAt: -1 }).lean();
    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// Preview upcoming matching sessions (next rounded +8h, from 8-hr project)
app.get("/preview-next", async (req, res) => {
  try {
    const now = new Date();

    // Fetch the NEXT upcoming 25 sessions from NOW
    const sessions = await Session.find({
      scheduledStartTime: { $gte: now.toISOString() },
    })
      .sort({ scheduledStartTime: 1 })
      .limit(25)
      .populate("userId")
      .lean();

    const results = [];

    for (const session of sessions) {
      const classId = session.classId;
      const subject = session.classSubject || "";
      const sessionStart = new Date(session.scheduledStartTime);

      // Fetch teacher for this session
      const teacherDoc = await Teacher.findOne(
        { "userId._id": String(session.userId?._id) },
        { "userId.name": 1, "userId.email": 1 }
      ).lean();

      const teacherName = teacherDoc?.userId?.name || "";
      const teacherEmail = teacherDoc?.userId?.email || "";

      // Fetch students
      const students = await User.find({
        relation: "STUDENT",
        status: "ACCEPTED",
        classes: { $elemMatch: { _id: classId } },
      })
        .populate("userId")
        .lean();

      for (const stu of students) {
        results.push({
          studentName: stu.userId?.name || stu.name || "",
          studentEmail: stu.userId?.email || "",
          teacherName,
          teacherEmail,
          subject,
          sessionStart: sessionStart.toLocaleString("en-US", {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }),
        });
      }
    }

    return res.json({
      searchStart: now.toISOString(),
      totalSessionsFound: sessions.length,
      totalStudentRows: results.length,
      data: results,
    });
  } catch (err) {
    console.error("preview-next error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/webhook/interakt", async (req, res) => {
  try {
    const data = req.body;

    console.log("📩 Interakt Webhook:", JSON.stringify(data).slice(0, 2000));

    // 1. Extract callbackData
    const cbRaw = data?.event_data?.message?.callbackData;
    let cb = null;

    try {
      cb = cbRaw ? JSON.parse(cbRaw) : null;
    } catch {
      cb = null;
    }

    if (!cb) {
      console.log("❌ No callbackData present.");
      return res.json({ ok: true });
    }

    const sessionId = cb.sessionId;
    const templateName = cb.template_name;

    // 2. Button values
    const buttonPressed =
      data?.event_data?.message?.interactive?.button_reply?.title || null;

    console.log("🔘 Button pressed:", buttonPressed);
    console.log("📌 Template:", templateName);
    console.log("📘 Session:", sessionId);

    const client = makeClient(process.env.INTERAKT_AUTH);

    /* ----------------------------------------------------
       1) 8-HOUR STUDENT REPLY → NOTIFY TEACHER
       template_name: "before_course_class8hr_student_reply_yes"
    ---------------------------------------------------- */
    if (templateName === "before_course_class8hr_student_reply_yes") {
      // Example: button contains "Yes" for positive response
      if (buttonPressed && buttonPressed.toLowerCase().includes("yes")) {
        const teacherPhone = cb.teacher_phone;
        const teacherName = cb.teacher_name || "Teacher";
        const studentName = cb.student_name || "Student";
        const subject = cb.subject || "your class";

        if (teacherPhone) {
          await sendTemplate(client, {
            fullPhoneNumber: teacherPhone,
            type: "Template",
            template: {
              // Teacher notification template
              name: "before_course_class_15mins_teachers_reply_ix",
              languageCode: "en",
              bodyValues: [teacherName, studentName, subject],
            },
            callbackData: JSON.stringify({
              sessionId,
              template_name: "before_course_class_15mins_teachers_reply_ix",
              teacher_name: teacherName,
              teacher_phone: teacherPhone,
              student_name: studentName,
              student_phone: cb.student_phone,
              subject,
            }),
          });

          console.log("📤 Sent 8hr STUDENT→TEACHER notification.");
        }
      }

      return res.json({ ok: true });
    }

    /* ----------------------------------------------------
       2) 15-MIN STUDENT REPLY → NOTIFY TEACHER
       template_name: "before_course_class_15min_student_reply"
    ---------------------------------------------------- */
    if (templateName === "before_course_class_15min_student_reply") {
      if (buttonPressed === "I'm joining on time") {
        const teacherPhone = cb.teacher_phone;
        const teacherName = cb.teacher_name || "Teacher";
        const studentName = cb.student_name || "Student";
        const subject = cb.subject || "your class";

        if (teacherPhone) {
          await sendTemplate(client, {
            fullPhoneNumber: teacherPhone,
            type: "Template",
            template: {
              name: "before_course_class_15mins_teachers_reply_ix",
              languageCode: "en",
              bodyValues: [teacherName, studentName, subject],
            },
            callbackData: JSON.stringify({
              sessionId,
              template_name: "before_course_class_15mins_teachers_reply_ix",
              teacher_name: teacherName,
              teacher_phone: teacherPhone,
              student_name: studentName,
              student_phone: cb.student_phone,
              subject,
            }),
          });

          console.log("📤 Sent 15min STUDENT→TEACHER notification.");
        }
      }

      return res.json({ ok: true });
    }

    /* ----------------------------------------------------
       3) 15-MIN TEACHER REPLY → NOTIFY STUDENT
       template_name: "before_course_class_15mins_teachers_tv"
    ---------------------------------------------------- */
    if (templateName === "before_course_class_15mins_teachers_tv") {
      if (buttonPressed === "Confirm Attendance") {
        const studentPhone = cb.student_phone;
        const studentName = cb.student_name || "Student";
        const teacherName = cb.teacher_name || "Teacher";
        const subject = cb.subject || "your class";

        if (!studentPhone) {
          console.log(
            "❌ No student_phone in callbackData. Cannot notify student."
          );
          return res.json({ ok: true });
        }

        await sendTemplate(client, {
          fullPhoneNumber: studentPhone,
          type: "Template",
          template: {
            // Use your student template (could also be a dedicated "teacher confirmed" template)
            name: "before_course_class_15min_student_",
            languageCode: "en",
            bodyValues: [studentName, subject],
          },
          callbackData: JSON.stringify({
            sessionId,
            template_name: "teacher_confirmed_attendance",
            teacher_name: teacherName,
            student_name: studentName,
            subject,
          }),
        });

        console.log("📤 Sent TEACHER→STUDENT confirmation.");
      }

      return res.json({ ok: true });
    }

    console.log("ℹ Unhandled callback template:", templateName);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false });
  }
});

// Basic root & health
app.get("/", (req, res) =>
  res.send("Course Reminder Backend (15min + 8hr) running")
);

app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await connect();

    mongoose.connection.on("connected", () => {
      console.log("Connected to MongoDB");
    });
    mongoose.connection.on("error", (err) => {
      console.error("MongoDB connection error:", err);
    });
    mongoose.connection.on("disconnected", () => {
      console.warn("MongoDB disconnected");
    });

    // Start both schedulers
    reminder15.startScheduler();
    reminder8hr.startScheduler();

    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
