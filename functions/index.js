const functions = require("firebase-functions");
const fetch = require("node-fetch");

// API Key 安全地存在服务端，前端看不到
const GEMINI_API_KEY = "YAIzaSyCnTz70327GJ-YPW4YRQpCWwteIIrXAeMM";
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

exports.geminiProxy = functions.https.onRequest(async (req, res) => {
  // 只允许 POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORS 头，允许你的 Firebase Hosting 域名访问
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  try {
    const { prompt, imageBase64 } = req.body;

    // 构建 Gemini 请求
    const parts = [{ text: prompt }];
    if (imageBase64) {
      parts.push({
        inlineData: { mimeType: "image/jpeg", data: imageBase64 },
      });
    }

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: parts }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "MINIMAL" },
          responseMimeType: "application/json",
        },
      }),
    });

    const json = await response.json();

    if (!json.candidates || !json.candidates[0]) {
      return res.status(500).json({ error: "Gemini returned no candidates." });
    }

    const rawText = json.candidates[0].content.parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join("");

    return res.status(200).json({ output: rawText });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});
