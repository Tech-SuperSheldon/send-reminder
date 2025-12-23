const axios = require("axios");

async function sendSagePilotTemplate({
  phone,
  customerName,
  templateName,
  bodyTexts = [],
}) {
  const payload = {
    customer_phone: phone,
    customer_name: customerName || "User",
    message_type: "template",
    channel_id: process.env.SAGEPILOT_CHANNEL_ID,
    template_name: templateName,
    parameter_type: "list",
    parameters: [
      {
        type: "body",
        parameters: bodyTexts.map((text) => ({
          type: "text",
          text: String(text),
        })),
      },
    ],
  };

  console.log("[SagePilot] Sending payload:", JSON.stringify(payload));

  try {
    const res = await axios.post(
      process.env.SAGEPILOT_BASE_URL,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.SAGEPILOT_TOKEN}`,
          "X-SP-Workspace-Id": process.env.SAGEPILOT_WORKSPACE_ID,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("[SagePilot] Success:", res.data);
    return { success: true, data: res.data };
  } catch (err) {
    console.error(
      "[SagePilot] Failed:",
      err.response?.data || err.message
    );
    return { success: false, error: err.response?.data || err.message };
  }
}

module.exports = {
  sendSagePilotTemplate,
};
