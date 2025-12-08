const mongoose = require("mongoose");

const teacherSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    instituteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institute", // If you don't have an Institute model, remove "ref"
      required: true,
    },

    classes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Class", // Remove ref if you do not use Class model
      },
    ],

    payoutSettings: {
      type: Object,
      default: {},
    },

    relation: {
      type: String,
      enum: ["TEACHER"],
      default: "TEACHER",
    },

    status: {
      type: String,
      enum: ["ACCEPTED", "PENDING", "REJECTED"],
      default: "ACCEPTED",
    },

    tags: {
      type: [String],
      default: [],
    },

    joinedOn: {
      type: Date,
      default: Date.now,
    },
  },

  { timestamps: true }
);

module.exports = mongoose.model("Teacher", teacherSchema);
