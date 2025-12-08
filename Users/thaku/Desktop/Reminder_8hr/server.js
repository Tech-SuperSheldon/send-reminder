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
    const { resultArray, sessionCount } = await reminder8hr.runNowOnce8hr();

    return res.json({
      ok: true,
      job: "8hr",
      totalSessions: sessionCount, // number of sessions found
      reminders: resultArray,
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

    // 3. Auto-response logic
    const client = makeClient(process.env.INTERAKT_AUTH);

    if (templateName === "before_course_class_15min_student_") {
      // Student replies
      if (buttonPressed === "I'm joining on time") {
        const phone = data.event_data.message.from;

        await sendTemplate(client, {
          fullPhoneNumber: phone,
          type: "Template",
          template: {
            name: "before_course_class_15mins_teachers_reply_ix",
            languageCode: "en",
            bodyValues: [
              data.event_data.message.profile?.name || "Student",
              "Subject", // Replace dynamically if you want
            ],
          },
        });

        console.log("📤 Sent STUDENT auto-reply message.");
      }
    }

    if (templateName === "before_course_class_15mins_teachers_tv") {
      // Teacher replies
      if (buttonPressed === "Confirm Attendance") {
        const phone = data.event_data.message.from;

        await sendTemplate(client, {
          fullPhoneNumber: phone,
          type: "Template",
          template: {
            name: "before_course_class_15mins_teachers_reply_ix",
            languageCode: "en",
            bodyValues: [
              data.event_data.message.profile?.name || "Teacher",
              "Subject",
              "StudentName",
            ],
          },
        });

        console.log("📤 Sent TEACHER auto-reply message.");
      }
    }

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
