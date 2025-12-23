require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { connect, mongoose } = require("./db");

const reminder15 = require("./jobs/reminder15Job");
const reminder8hr = require("./jobs/reminder8hrJob");

const Session = require("./models/session");
const Teacher = require("./models/teacher");
const User = require("./models/user");

const Session8hrLog = require("./models/session8hrLog");
const ReminderLog = require("./models/sessionReminderLog");

const app = express();
app.use(express.json());

const FRONTEND_URL = "http://localhost:5173";

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);



/* -------------------- Manual triggers -------------------- */

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
      totalSessions: data.totalSessions ?? data.sessions ?? null,
      reminders: data.reminders ?? null,
    });
  } catch (err) {
    console.error("run-now (8hr) error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* -------------------- Logs APIs -------------------- */

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

/* -------------------- Preview API (unchanged) -------------------- */

// Preview upcoming sessions (next 25 sessions from NOW)
app.get("/preview-next", async (req, res) => {
  try {
    const now = new Date();

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

      const teacherDoc = await Teacher.findOne(
        { "userId._id": String(session.userId?._id) },
        { "userId.name": 1, "userId.email": 1 }
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

/* -------------------- Root & Health -------------------- */

app.get("/", (req, res) =>
  res.send("Course Reminder Backend (15min + 8hr) running (SagePilot send-only)")
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

    // Start schedulers
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
