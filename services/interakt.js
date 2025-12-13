// services/interakt.js
const axios = require("axios");

function makeClient(authHeader) {
  const client = axios.create({
    baseURL: "https://api.interakt.ai/v1/public/",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  return client;
}

async function sendTemplate(client, payload) {
  try {
    const res = await client.post("/message/", payload);
    return { success: true, status: res.status, data: res.data };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      responseData: err.response?.data || null,
      status: err.response?.status || null,
    };
  }
}

module.exports = { makeClient, sendTemplate };
