import { createServer, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { extname, relative, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const outputsDir = resolve(__dirname, "outputs");
const port = Number(process.env.PORT || 3000);
const maxAudioBytes = 25 * 1024 * 1024;
const maxJsonBytes = 1024 * 1024;
let nextVersionId = 1;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp"
};

const audioExtensions = {
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm"
};

await loadEnvFile();

function getOutboundProxyUrl() {
  return process.env.OPENAI_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
}

async function loadEnvFile() {
  try {
    const envFile = await readFile(resolve(__dirname, ".env"), "utf8");

    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const equalsIndex = trimmed.indexOf("=");

      if (equalsIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, equalsIndex).trim().replace(/^\uFEFF/, "");
      const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

class HttpsProxyAgent extends HttpsAgent {
  constructor(proxyUrl) {
    super();
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, callback) {
    const proxy = this.proxy;
    const proxySocket = netConnect(
      Number(proxy.port || 80),
      proxy.hostname,
      () => {
        const targetHost = `${options.host}:${options.port || 443}`;
        const headers = [
          `CONNECT ${targetHost} HTTP/1.1`,
          `Host: ${targetHost}`,
          "Proxy-Connection: Keep-Alive"
        ];

        if (proxy.username || proxy.password) {
          const credentials = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
          headers.push(`Proxy-Authorization: Basic ${credentials}`);
        }

        proxySocket.write(`${headers.join("\r\n")}\r\n\r\n`);
      }
    );
    let buffered = Buffer.alloc(0);

    proxySocket.on("data", function onProxyData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");

      if (headerEnd === -1) {
        return;
      }

      proxySocket.off("data", onProxyData);

      const header = buffered.slice(0, headerEnd).toString("utf8");
      const remaining = buffered.slice(headerEnd + 4);

      if (!/^HTTP\/1\.[01] 200/i.test(header)) {
        callback(new Error(`Proxy CONNECT failed: ${header.split("\r\n")[0]}`));
        proxySocket.destroy();
        return;
      }

      if (remaining.length > 0) {
        proxySocket.unshift(remaining);
      }

      const tlsSocket = tlsConnect({
        socket: proxySocket,
        servername: options.servername || options.host
      });
      callback(null, tlsSocket);
    });

    proxySocket.on("error", callback);
  }
}

function createHttpsProxyAgent(proxyUrl) {
  return new HttpsProxyAgent(proxyUrl);
}

async function requestRaw(url, { method = "GET", body, headers = {}, timeoutMs = 120000 } = {}) {
  const proxyUrl = getOutboundProxyUrl();
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "http:" ? httpRequest : httpsRequest;
  const useProxy = requestUrl.protocol === "https:" && proxyUrl;
  const requestHeaders = { ...headers };

  if (body !== undefined && !("Content-Length" in requestHeaders) && !("content-length" in requestHeaders)) {
    requestHeaders["Content-Length"] = Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(String(body));
  }

  return new Promise((resolveRequest, rejectRequest) => {
    const request = transport(requestUrl, {
      method,
      agent: useProxy ? createHttpsProxyAgent(proxyUrl) : undefined,
      headers: requestHeaders,
      timeout: timeoutMs
    }, (apiResponse) => {
      const chunks = [];

      apiResponse.on("data", (chunk) => {
        chunks.push(chunk);
      });

      apiResponse.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload = {};

        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = { raw: text };
        }

        resolveRequest({
          ok: apiResponse.statusCode >= 200 && apiResponse.statusCode < 300,
          status: apiResponse.statusCode,
          text,
          payload
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Outbound request timed out"));
    });
    request.on("error", rejectRequest);
    request.end(body);
  });
}

async function requestJson(url, { method = "GET", body, headers = {}, timeoutMs = 120000 } = {}) {
  const bodyText = body === undefined ? undefined : JSON.stringify(body);

  return requestRaw(url, {
    method,
    body: bodyText,
    headers: {
      ...(bodyText ? {
        "Content-Type": "application/json"
      } : {}),
      ...headers
    },
    timeoutMs
  });
}

async function postJson(url, body, headers = {}) {
  return requestJson(url, {
    method: "POST",
    body,
    headers
  });
}

async function postFormData(url, formData, headers = {}) {
  const serializedRequest = new Request(url, {
    method: "POST",
    headers,
    body: formData
  });
  const bodyBuffer = Buffer.from(await serializedRequest.arrayBuffer());

  return requestRaw(url, {
    method: "POST",
    body: bodyBuffer,
    headers: {
      ...headers,
      "Content-Type": serializedRequest.headers.get("content-type")
    }
  });
}

async function getJson(url, headers = {}) {
  return requestJson(url, {
    method: "GET",
    headers
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function readRequestBody(request) {
  return readLimitedRequestBody(request, maxAudioBytes, "Audio file is too large");
}

async function readLimitedRequestBody(request, maxBytes, message) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.byteLength;

    if (totalBytes > maxBytes) {
      const error = new Error(message);
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const body = await readLimitedRequestBody(request, maxJsonBytes, "Request body is too large");

  if (body.byteLength === 0) {
    return {};
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function getAudioExtension(contentType) {
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  return audioExtensions[mimeType] || "webm";
}

function getTranscriptionPrompt() {
  return process.env.TRANSCRIBE_PROMPT || [
    "这是一段中文语音指令，用于 AI 文生图工具。",
    "请优先识别成画面描述、主体、风格、构图、比例和确认命令。",
    "常见词包括：生成、画、确认、不对、改成、赛博朋克、鱼、猫、狗、人物、机器人、城市、横版、竖版、16:9、16:10。",
    "如果听到“一只赛博朋克的鱼”，不要写成“雨衣”或“语音”。"
  ].join("\n");
}

function normalizeTranscriptForImagePrompt(text) {
  return String(text || "")
    .trim()
    .replace(/(一[只条][^，。,.!?！？]*?赛博朋克(?:风格)?的?)(雨衣|语音)/gu, "$1鱼");
}

function getTranscriptionProvider() {
  return String(process.env.TRANSCRIBE_PROVIDER || "osum").trim().toLowerCase();
}

function getOsumModel() {
  return process.env.OSUM_MODEL || "OSUM";
}

function getOsumApiUrl() {
  return String(process.env.OSUM_API_URL || "").trim();
}

function getOsumTaskPrompt() {
  return process.env.OSUM_TASK_PROMPT || "请转写这段语音，同时识别说话人性别、年龄段和情感。请返回 JSON，字段为 text, gender, age, emotion。";
}

function normalizeSpeechAttribute(value) {
  return String(value || "").trim();
}

function findFirstString(payload, keys) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  for (const key of keys) {
    const value = payload[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function extractTaggedValue(text, tags) {
  const rawText = String(text || "");

  for (const tag of tags) {
    const closedPattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "iu");
    const closedMatch = rawText.match(closedPattern);

    if (closedMatch?.[1]) {
      return closedMatch[1].trim();
    }

    const openPattern = new RegExp(`<${tag}>\\s*([^<\\n\\r]+)`, "iu");
    const openMatch = rawText.match(openPattern);

    if (openMatch?.[1]) {
      return openMatch[1].trim();
    }
  }

  return "";
}

function extractOsumTranscription(payload) {
  const directText = extractMimoTranscription(payload)
    || findFirstString(payload, ["asr", "transcript", "transcription_text", "speech_text"]);

  if (directText) {
    return directText;
  }

  const rawText = typeof payload === "string" ? payload : JSON.stringify(payload || {});
  return extractTaggedValue(rawText, ["asr", "transcript", "text"]);
}

function extractOsumSpeaker(payload) {
  const rawText = typeof payload === "string" ? payload : JSON.stringify(payload || {});

  return {
    gender: normalizeSpeechAttribute(
      findFirstString(payload, ["gender", "speakerGender", "speaker_gender", "sgc"])
      || extractTaggedValue(rawText, ["gender", "speaker_gender", "sgc"])
    ),
    age: normalizeSpeechAttribute(
      findFirstString(payload, ["age", "ageGroup", "age_group", "speakerAge", "speaker_age", "sap"])
      || extractTaggedValue(rawText, ["age", "age_group", "speaker_age", "sap"])
    ),
    emotion: normalizeSpeechAttribute(
      findFirstString(payload, ["emotion", "speechEmotion", "speech_emotion", "ser"])
      || extractTaggedValue(rawText, ["emotion", "speech_emotion", "ser"])
    )
  };
}

async function transcribeWithOsum(audioBuffer, contentType) {
  if (process.env.MOCK_TRANSCRIPT) {
    return {
      text: normalizeTranscriptForImagePrompt(process.env.MOCK_TRANSCRIPT),
      rawText: process.env.MOCK_TRANSCRIPT,
      source: "mock",
      model: getOsumModel(),
      speaker: {
        gender: process.env.MOCK_GENDER || "",
        age: process.env.MOCK_AGE || "",
        emotion: process.env.MOCK_EMOTION || ""
      }
    };
  }

  const endpoint = getOsumApiUrl();

  if (!endpoint) {
    const error = new Error("Missing OSUM_API_URL. Start an OSUM speech service and add OSUM_API_URL to .env.");
    error.statusCode = 503;
    throw error;
  }

  const fileName = getAudioFileName(contentType);
  const formData = new FormData();
  formData.append("file", new File([audioBuffer], fileName, {
    type: contentType || "audio/webm"
  }));
  formData.append("model", getOsumModel());
  formData.append("tasks", JSON.stringify(["asr", "sgc", "sap", "ser"]));
  formData.append("prompt", getOsumTaskPrompt());

  const apiResponse = await postFormData(endpoint, formData);

  if (!apiResponse.ok) {
    const message = apiResponse.payload.error?.message
      || apiResponse.payload.error
      || apiResponse.payload.message
      || "OSUM speech model request failed";
    const error = new Error(message);
    error.statusCode = apiResponse.status === 404 ? 503 : 502;
    throw error;
  }

  const text = extractOsumTranscription(apiResponse.payload);

  if (!text) {
    const error = new Error("OSUM speech model did not return transcription text");
    error.statusCode = 502;
    throw error;
  }

  return {
    text: normalizeTranscriptForImagePrompt(text),
    rawText: text,
    source: "osum",
    model: getOsumModel(),
    speaker: extractOsumSpeaker(apiResponse.payload)
  };
}

function getMimoAsrModel() {
  return process.env.MIMO_ASR_MODEL || "mimo-v2.5-asr";
}

function getMimoAsrBaseUrl() {
  return (process.env.MIMO_ASR_BASE_URL || "https://xiaomimimo-mimo-v2-5-asr.hf.space").replace(/\/+$/u, "");
}

function getMimoAsrLanguage() {
  return process.env.MIMO_ASR_LANGUAGE || "Chinese";
}

function getMimoAuthHeaders() {
  if (!process.env.HF_TOKEN) {
    return {};
  }

  return {
    Authorization: `Bearer ${process.env.HF_TOKEN}`
  };
}

function getAudioFileName(contentType) {
  return `speech.${getAudioExtension(contentType)}`;
}

function extractMimoTranscription(payload) {
  if (!payload) {
    return "";
  }

  if (typeof payload === "string") {
    return payload.trim();
  }

  if (typeof payload.text === "string") {
    return payload.text.trim();
  }

  if (typeof payload.transcription === "string") {
    return payload.transcription.trim();
  }

  if (typeof payload.result === "string") {
    return payload.result.trim();
  }

  if (Array.isArray(payload.data)) {
    const textOutput = payload.data.find((item) => typeof item === "string" && item.trim());
    return textOutput ? textOutput.trim() : "";
  }

  if (Array.isArray(payload)) {
    const textOutput = payload.find((item) => typeof item === "string" && item.trim());
    return textOutput ? textOutput.trim() : "";
  }

  return "";
}

function extractGradioEventPayload(eventText) {
  const dataLines = String(eventText || "")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");

  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(dataLines[index]);
    } catch {
      // Keep searching earlier event payloads.
    }
  }

  return undefined;
}

function getGradioUploadedFile(uploadPayload, fileName, contentType, audioBuffer) {
  const uploadedFile = Array.isArray(uploadPayload)
    ? uploadPayload[0]
    : uploadPayload?.files?.[0] || uploadPayload?.file || uploadPayload?.path;
  const uploadedPath = typeof uploadedFile === "string" ? uploadedFile : uploadedFile?.path || uploadedFile?.name;

  if (!uploadedPath) {
    const error = new Error("MiMo ASR did not return an uploaded audio path");
    error.statusCode = 502;
    throw error;
  }

  return {
    path: uploadedPath,
    orig_name: fileName,
    size: audioBuffer.byteLength,
    mime_type: contentType || "audio/webm",
    meta: {
      _type: "gradio.FileData"
    }
  };
}

async function callMimoLocalEndpoint(audioBuffer, contentType) {
  const endpoint = process.env.MIMO_ASR_API_URL;

  if (!endpoint) {
    return undefined;
  }

  const fileName = getAudioFileName(contentType);
  const formData = new FormData();
  formData.append("file", new File([audioBuffer], fileName, {
    type: contentType || "audio/webm"
  }));
  formData.append("model", getMimoAsrModel());
  formData.append("language", getMimoAsrLanguage());

  const apiResponse = await postFormData(endpoint, formData, getMimoAuthHeaders());

  if (!apiResponse.ok) {
    const message = apiResponse.payload.error?.message
      || apiResponse.payload.error
      || apiResponse.payload.message
      || "MiMo ASR endpoint failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  return extractMimoTranscription(apiResponse.payload);
}

async function callMimoGradioSpace(audioBuffer, contentType) {
  const baseUrl = getMimoAsrBaseUrl();
  const fileName = getAudioFileName(contentType);
  const formData = new FormData();
  formData.append("files", new File([audioBuffer], fileName, {
    type: contentType || "audio/webm"
  }));

  const uploadResponse = await postFormData(`${baseUrl}/gradio_api/upload`, formData, getMimoAuthHeaders());

  if (!uploadResponse.ok) {
    const message = uploadResponse.payload.error?.message
      || uploadResponse.payload.error
      || uploadResponse.payload.message
      || "MiMo ASR audio upload failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  const audioFile = getGradioUploadedFile(uploadResponse.payload, fileName, contentType, audioBuffer);
  const data = [audioFile, null, getMimoAsrLanguage()];
  const endpoints = [
    process.env.MIMO_ASR_GRADIO_API || "predict",
    "transcribe"
  ].filter(Boolean);
  let lastError;

  for (const endpoint of endpoints) {
    try {
      const createResponse = await postJson(`${baseUrl}/gradio_api/call/${endpoint}`, { data }, getMimoAuthHeaders());

      if (!createResponse.ok) {
        throw new Error(createResponse.payload.error?.message || createResponse.payload.error || createResponse.payload.message || `MiMo ASR call failed: ${endpoint}`);
      }

      const eventId = createResponse.payload.event_id || createResponse.payload.hash;

      if (eventId) {
        const resultResponse = await requestRaw(`${baseUrl}/gradio_api/call/${endpoint}/${eventId}`, {
          headers: getMimoAuthHeaders(),
          timeoutMs: Number(process.env.MIMO_ASR_TIMEOUT_MS || 180000)
        });

        if (!resultResponse.ok) {
          throw new Error(resultResponse.payload.error?.message || resultResponse.payload.error || resultResponse.payload.message || `MiMo ASR result failed: ${endpoint}`);
        }

        return extractMimoTranscription({
          data: extractGradioEventPayload(resultResponse.text)
        });
      }

      return extractMimoTranscription(createResponse.payload);
    } catch (error) {
      lastError = error;
    }
  }

  const legacyResponse = await postJson(`${baseUrl}/api/predict`, {
    data,
    fn_index: 0
  }, getMimoAuthHeaders());

  if (!legacyResponse.ok) {
    const message = legacyResponse.payload.error?.message
      || legacyResponse.payload.error
      || legacyResponse.payload.message
      || lastError?.message
      || "MiMo ASR prediction failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  return extractMimoTranscription(legacyResponse.payload);
}

async function transcribeWithMimo(audioBuffer, contentType) {
  if (process.env.MOCK_TRANSCRIPT) {
    return {
      text: normalizeTranscriptForImagePrompt(process.env.MOCK_TRANSCRIPT),
      rawText: process.env.MOCK_TRANSCRIPT,
      source: "mock"
    };
  }

  const localText = await callMimoLocalEndpoint(audioBuffer, contentType);
  const text = localText || await callMimoGradioSpace(audioBuffer, contentType);

  if (!text) {
    const error = new Error("MiMo ASR did not return transcription text");
    error.statusCode = 502;
    throw error;
  }

  return {
    text: normalizeTranscriptForImagePrompt(text),
    rawText: text,
    source: "mimo",
    model: getMimoAsrModel()
  };
}

async function transcribeWithOpenAI(audioBuffer, contentType) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("Missing OPENAI_API_KEY. Add it to .env before transcribing.");
    error.statusCode = 503;
    throw error;
  }

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
  const language = process.env.TRANSCRIBE_LANGUAGE || "zh";
  const prompt = getTranscriptionPrompt();
  const extension = getAudioExtension(contentType);
  const formData = new FormData();
  const audioFile = new File([audioBuffer], `speech.${extension}`, {
    type: contentType || "audio/webm"
  });

  formData.append("file", audioFile);
  formData.append("model", model);

  if (language) {
    formData.append("language", language);
  }

  if (prompt) {
    formData.append("prompt", prompt);
  }

  formData.append("temperature", "0");

  const apiResponse = await postFormData("https://api.openai.com/v1/audio/transcriptions", formData, {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
  });
  const payload = apiResponse.payload;

  if (!apiResponse.ok) {
    const message = payload.error?.message || "OpenAI transcription failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  return {
    text: normalizeTranscriptForImagePrompt(payload.text),
    rawText: payload.text || "",
    source: "openai",
    model
  };
}

async function transcribeAudio(audioBuffer, contentType) {
  const provider = getTranscriptionProvider();

  if (provider === "osum" || provider === "osum-pangu") {
    return transcribeWithOsum(audioBuffer, contentType);
  }

  if (provider === "mimo" || provider === "mimo-v2.5-asr" || provider === "xiaomi") {
    return transcribeWithMimo(audioBuffer, contentType);
  }

  if (provider === "openai") {
    return transcribeWithOpenAI(audioBuffer, contentType);
  }

  const error = new Error(`Unsupported transcription provider: ${provider}`);
  error.statusCode = 400;
  throw error;
}

async function handleTranscribe(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const contentType = request.headers["content-type"] || "audio/webm";

  if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
    sendJson(response, 415, { error: "Only audio uploads are supported" });
    return;
  }

  const audioBuffer = await readRequestBody(request);

  if (audioBuffer.byteLength === 0) {
    sendJson(response, 400, { error: "Audio upload is empty" });
    return;
  }

  const startedAt = Date.now();
  const result = await transcribeAudio(audioBuffer, contentType);

  sendJson(response, 200, {
    ok: true,
    text: result.text,
    rawText: result.rawText,
    source: result.source,
    model: result.model,
    speaker: result.speaker || {},
    gender: result.speaker?.gender || "",
    age: result.speaker?.age || "",
    emotion: result.speaker?.emotion || "",
    bytes: audioBuffer.byteLength,
    elapsedMs: Date.now() - startedAt
  });
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function inferStyle(text) {
  const styles = [
    { keywords: ["赛博朋克", "霓虹", "cyberpunk"], value: "赛博朋克风格" },
    { keywords: ["小红书", "干净", "清爽"], value: "干净清爽" },
    { keywords: ["写实", "真实", "摄影"], value: "写实摄影" },
    { keywords: ["动漫", "二次元", "漫画"], value: "动漫插画" },
    { keywords: ["水彩"], value: "水彩插画" },
    { keywords: ["油画"], value: "油画质感" },
    { keywords: ["像素"], value: "像素艺术" },
    { keywords: ["极简", "简约"], value: "极简风格" },
    { keywords: ["国风", "中国风"], value: "国风插画" }
  ];

  return styles.find((style) => includesAny(text, style.keywords))?.value || "高质量视觉风格";
}

function inferSubject(text) {
  const cleaned = text
    .replace(/^(帮我|请|麻烦|给我|我想|想要)?(生成|画|做|设计|来一张|出一张|制作)?/u, "")
    .replace(/(图片|图|画面|封面|海报)$/u, "")
    .trim();

  return cleaned || text.trim();
}

function inferMustAvoid(text) {
  const avoid = [];

  if (includesAny(text, ["不要文字", "无文字", "不要复杂文字", "不要字"])) {
    avoid.push("复杂文字");
  }

  if (includesAny(text, ["不要水印", "无水印"])) {
    avoid.push("水印");
  }

  if (includesAny(text, ["不要变形", "别变形"])) {
    avoid.push("明显变形");
  }

  return avoid;
}

function buildCommandPrompt(command) {
  return [
    command.subject,
    command.style,
    command.aspectRatio ? `${command.aspectRatio} 画幅` : "",
    command.mustAvoid?.length ? `避免：${command.mustAvoid.join("、")}` : ""
  ].filter(Boolean).join("，");
}

function buildGenerateCommand(text, previousCommand) {
  const aspectRatio = parseAspectRatio(text);
  const command = {
    intent: "generate",
    subject: inferSubject(text),
    style: inferStyle(text),
    aspectRatio: aspectRatio.label,
    mustKeep: previousCommand?.mustKeep || [],
    mustAvoid: inferMustAvoid(text),
    needConfirmation: true
  };

  command.prompt = buildCommandPrompt(command);
  command.replyToUser = `我理解为：生成一张${command.subject}，风格是${command.style}，画幅为${command.aspectRatio}。${command.mustAvoid.length ? `避免${command.mustAvoid.join("、")}。` : ""}是否确认？`;
  return command;
}

function buildRevisedCommand(text, previousCommand) {
  const revision = text.replace(/^(改成|换成|调整为|改为|变成|不对，?|不是，?)/u, "").trim();
  const baseText = [previousCommand?.subject, revision].filter(Boolean).join("，");
  const command = buildGenerateCommand(baseText || text, previousCommand);

  command.intent = "generate";
  command.userRevision = text;
  command.replyToUser = `我已改成：${command.subject}，风格是${command.style}，画幅为${command.aspectRatio}。是否确认？`;
  return command;
}

function parseCommand(text, previousCommand) {
  const normalizedText = String(text || "").trim();

  if (!normalizedText) {
    const error = new Error("Command text is required");
    error.statusCode = 400;
    throw error;
  }

  if (includesAny(normalizedText, ["确认", "可以", "没问题", "对", "开始生成", "就这样"]) && !includesAny(normalizedText, ["不对", "不是", "不要"])) {
    return {
      intent: "confirm",
      needConfirmation: false,
      replyToUser: previousCommand ? "已确认，开始生成图片。" : "还没有待确认的需求，请先说出想生成的画面。"
    };
  }

  if (includesAny(normalizedText, ["不对", "不是", "取消", "重新说", "先别生成"])) {
    return {
      intent: "reject",
      needConfirmation: false,
      replyToUser: "好的，已取消。请重新说出你想生成的画面。"
    };
  }

  if (previousCommand && includesAny(normalizedText, ["改成", "换成", "调整为", "改为", "变成"])) {
    return buildRevisedCommand(normalizedText, previousCommand);
  }

  return buildGenerateCommand(normalizedText, previousCommand);
}

async function handleCommand(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const payload = await readJsonBody(request);
  const commandText = normalizeTranscriptForImagePrompt(payload.text);
  const command = parseCommand(commandText, payload.previousCommand);

  sendJson(response, 200, {
    ok: true,
    command
  });
}

function hasExplicitAspectRatio(prompt, width, height) {
  const pattern = new RegExp(`(?:^|[^0-9])${width}\\s*(?::|：|比)\\s*${height}(?:$|[^0-9])`, "u");
  return pattern.test(prompt);
}

function parseAspectRatio(prompt) {
  const normalizedPrompt = String(prompt || "").toLowerCase();
  const explicitRatios = [
    { width: 16, height: 10, label: "16:10", size: "1536x1024" },
    { width: 10, height: 16, label: "10:16", size: "1024x1536" },
    { width: 16, height: 9, label: "16:9", size: "1536x1024" },
    { width: 9, height: 16, label: "9:16", size: "1024x1536" },
    { width: 3, height: 4, label: "3:4", size: "1024x1536" },
    { width: 4, height: 3, label: "4:3", size: "1536x1024" },
    { width: 1, height: 1, label: "1:1", size: "1024x1024" }
  ];
  const explicitRatio = explicitRatios.find((ratio) => hasExplicitAspectRatio(
    normalizedPrompt,
    ratio.width,
    ratio.height
  ));

  if (explicitRatio) {
    return {
      label: explicitRatio.label,
      size: explicitRatio.size
    };
  }

  if (/横版|横图|宽屏|电脑壁纸|banner/.test(normalizedPrompt)) {
    return {
      label: "16:9",
      size: "1536x1024"
    };
  }

  if (/竖版|竖图|手机壁纸|故事|海报/.test(normalizedPrompt)) {
    return {
      label: "9:16",
      size: "1024x1536"
    };
  }

  if (/小红书|封面/.test(normalizedPrompt)) {
    return {
      label: "3:4",
      size: "1024x1536"
    };
  }

  return {
    label: "1:1",
    size: "1024x1024"
  };
}

function buildImagePrompt(userPrompt) {
  return [
    String(userPrompt || "").trim(),
    "High quality image, coherent composition, no watermark, no UI chrome."
  ].filter(Boolean).join("\n");
}

function escapeSvgText(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrapText(text, maxLength = 18) {
  const characters = Array.from(String(text || ""));
  const lines = [];

  for (let index = 0; index < characters.length; index += maxLength) {
    lines.push(characters.slice(index, index + maxLength).join(""));
  }

  return lines.slice(0, 4);
}

function buildLocalPreviewSvg(prompt, aspectRatio) {
  const [width, height] = aspectRatio.size.split("x").map(Number);
  const lines = wrapText(prompt).map((line, index) => {
    const y = height * 0.62 + index * 48;
    return `<text x="${width * 0.08}" y="${y}" font-size="34" fill="#f8fbff">${escapeSvgText(line)}</text>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12243a"/>
      <stop offset="0.52" stop-color="#162f31"/>
      <stop offset="1" stop-color="#e0523f"/>
    </linearGradient>
    <radialGradient id="glow" cx="35%" cy="28%" r="42%">
      <stop offset="0" stop-color="#f3df8d" stop-opacity="0.9"/>
      <stop offset="0.48" stop-color="#57b6bd" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#101823" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse">
      <path d="M72 0H0V72" fill="none" stroke="#54c5c9" stroke-opacity="0.22" stroke-width="2"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <rect y="${height * 0.55}" width="100%" height="${height * 0.45}" fill="url(#grid)" opacity="0.62"/>
  <circle cx="${width * 0.75}" cy="${height * 0.22}" r="${Math.min(width, height) * 0.14}" fill="#ffffff" opacity="0.1"/>
  <text x="${width * 0.08}" y="${height * 0.12}" font-size="28" font-family="Arial, sans-serif" fill="#d9fbff" font-weight="700">LOCAL PREVIEW</text>
  <text x="${width * 0.08}" y="${height * 0.2}" font-size="52" font-family="Arial, sans-serif" fill="#ffffff" font-weight="800">Drawtalk</text>
  <text x="${width * 0.08}" y="${height * 0.28}" font-size="28" font-family="Arial, sans-serif" fill="#c6d6dd">配置 OPENAI_API_KEY 后生成真实 AI 图片</text>
  <text x="${width * 0.08}" y="${height * 0.54}" font-size="30" font-family="Arial, sans-serif" fill="#b9e6e9">识别到的提示词</text>
  <g font-family="Arial, 'Microsoft YaHei', sans-serif" font-weight="700">${lines}</g>
</svg>`;
}

function detectImageExtension(imageBuffer) {
  if (imageBuffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return "png";
  }

  if (imageBuffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "jpg";
  }

  if (imageBuffer.subarray(0, 4).toString("ascii") === "RIFF" && imageBuffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }

  return "png";
}

async function saveGeneratedImage({ imageBase64, extension }) {
  const versionId = nextVersionId;
  nextVersionId += 1;
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const imageExtension = extension || detectImageExtension(imageBuffer);
  const fileName = `version-${versionId}.${imageExtension}`;
  const imagePath = resolve(outputsDir, fileName);

  await mkdir(outputsDir, { recursive: true });
  await writeFile(imagePath, imageBuffer);

  return {
    versionId,
    imageUrl: `/outputs/${fileName}`
  };
}

async function saveLocalPreviewImage({ prompt, aspectRatio }) {
  const versionId = nextVersionId;
  nextVersionId += 1;
  const fileName = `version-${versionId}.svg`;
  const imagePath = resolve(outputsDir, fileName);

  await mkdir(outputsDir, { recursive: true });
  await writeFile(imagePath, buildLocalPreviewSvg(prompt, aspectRatio), "utf8");

  return {
    versionId,
    imageUrl: `/outputs/${fileName}`
  };
}

function getHordeDimensions(aspectRatio) {
  const dimensions = {
    "16:9": { width: 576, height: 320 },
    "16:10": { width: 512, height: 320 },
    "9:16": { width: 320, height: 576 },
    "10:16": { width: 320, height: 512 },
    "3:4": { width: 384, height: 512 },
    "4:3": { width: 512, height: 384 },
    "1:1": { width: 384, height: 384 }
  };

  return dimensions[aspectRatio.label] || dimensions["1:1"];
}

function normalizeImageBase64(image) {
  if (!image) {
    return "";
  }

  return image.includes(",") ? image.split(",").pop() : image;
}

function getHordeHeaders() {
  return {
    apikey: process.env.HORDE_API_KEY || "0000000000",
    "Client-Agent": "drawtalk:0.1.0:https://localhost"
  };
}

function getHordeModel() {
  return process.env.HORDE_IMAGE_MODEL || "AbsoluteReality";
}

async function generateImageWithHorde({ prompt, aspectRatio }) {
  const dimensions = getHordeDimensions(aspectRatio);
  const model = getHordeModel();
  const requestBody = {
    prompt,
    params: {
      n: 1,
      width: dimensions.width,
      height: dimensions.height,
      steps: Number(process.env.HORDE_STEPS || 10),
      cfg_scale: Number(process.env.HORDE_CFG_SCALE || 7)
    },
    nsfw: false,
    trusted_workers: false,
    censor_nsfw: true,
    r2: false,
    models: [model]
  };

  const createResponse = await postJson(
    "https://aihorde.net/api/v2/generate/async",
    requestBody,
    getHordeHeaders()
  );

  if (!createResponse.ok) {
    const message = createResponse.payload.message || createResponse.payload.error?.message || "AI Horde image generation request failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  const generationId = createResponse.payload.id;

  if (!generationId) {
    const error = new Error("AI Horde did not return a generation id");
    error.statusCode = 502;
    throw error;
  }

  const timeoutMs = Number(process.env.HORDE_TIMEOUT_MS || 180000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const checkResponse = await getJson(
      `https://aihorde.net/api/v2/generate/check/${generationId}`,
      getHordeHeaders()
    );

    if (!checkResponse.ok) {
      const message = checkResponse.payload.message || checkResponse.payload.error?.message || "AI Horde status check failed";
      const error = new Error(message);
      error.statusCode = 502;
      throw error;
    }

    if (checkResponse.payload.done) {
      const statusResponse = await getJson(
        `https://aihorde.net/api/v2/generate/status/${generationId}`,
        getHordeHeaders()
      );

      if (!statusResponse.ok) {
        const message = statusResponse.payload.message || statusResponse.payload.error?.message || "AI Horde result fetch failed";
        const error = new Error(message);
        error.statusCode = 502;
        throw error;
      }

      const generation = statusResponse.payload.generations?.[0];
      const imageBase64 = normalizeImageBase64(generation?.img);

      if (!imageBase64 || generation?.censored) {
        const error = new Error(generation?.censored ? "AI Horde censored this generation" : "AI Horde did not return image data");
        error.statusCode = 502;
        throw error;
      }

      return {
        imageBase64,
        model: generation.model || model,
        dimensions,
        generationId
      };
    }

    const waitSeconds = Math.max(2, Math.min(Number(checkResponse.payload.wait_time || 4), 10));
    await delay(waitSeconds * 1000);
  }

  const error = new Error("AI Horde generation timed out. Please try again.");
  error.statusCode = 504;
  throw error;
}

async function generateImageWithOpenAI({ prompt, size }) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("Missing OPENAI_API_KEY. Local preview image was used instead.");
    error.statusCode = 503;
    throw error;
  }

  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const response = await postJson("https://api.openai.com/v1/images/generations", {
    model,
    prompt,
    n: 1,
    size
  }, {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
  });

  const payload = response.payload;

  if (!response.ok) {
    const message = payload.error?.message || "OpenAI image generation failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  const imageBase64 = payload.data?.[0]?.b64_json;

  if (!imageBase64) {
    const error = new Error("OpenAI image response did not include image data");
    error.statusCode = 502;
    throw error;
  }

  return {
    imageBase64,
    model
  };
}

function normalizeImageProvider(provider) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();

  if (["openai", "gpt", "gpt-image", "gpt image"].includes(normalizedProvider)) {
    return "openai";
  }

  if (["horde", "ai-horde", "ai horde"].includes(normalizedProvider)) {
    return "horde";
  }

  return "";
}

async function handleGenerateImage(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const payload = await readJsonBody(request);
  const userPrompt = String(payload.prompt || "").trim();

  if (!userPrompt) {
    sendJson(response, 400, { error: "Prompt is required" });
    return;
  }

  const startedAt = Date.now();
  const aspectRatio = parseAspectRatio(userPrompt);
  const generationPrompt = buildImagePrompt(userPrompt);
  const provider = normalizeImageProvider(payload.provider || process.env.IMAGE_PROVIDER || "horde");

  if (!provider) {
    sendJson(response, 400, { error: "Unsupported image provider" });
    return;
  }

  const params = {
    provider,
    model: provider === "openai" ? process.env.OPENAI_IMAGE_MODEL || "gpt-image-1" : process.env.HORDE_IMAGE_MODEL || "AI Horde",
    size: aspectRatio.size,
    n: 1,
    aspectRatio: aspectRatio.label
  };
  let savedImage;
  let source = provider;

  try {
    if (provider === "openai") {
      const generated = await generateImageWithOpenAI({
        prompt: generationPrompt,
        size: aspectRatio.size
      });

      params.model = generated.model;
      savedImage = await saveGeneratedImage({ imageBase64: generated.imageBase64 });
    } else if (provider === "horde") {
      const generated = await generateImageWithHorde({
        prompt: generationPrompt,
        aspectRatio
      });

      params.model = generated.model;
      params.size = `${generated.dimensions.width}x${generated.dimensions.height}`;
      params.generationId = generated.generationId;
      savedImage = await saveGeneratedImage({ imageBase64: generated.imageBase64 });
    } else {
      const error = new Error(`Unsupported IMAGE_PROVIDER: ${provider}`);
      error.statusCode = 400;
      throw error;
    }
  } catch (error) {
    if (error.statusCode !== 503) {
      throw error;
    }

    source = "local-preview";
    savedImage = await saveLocalPreviewImage({
      prompt: userPrompt,
      aspectRatio
    });
  }

  sendJson(response, 200, {
    ok: true,
    version: {
      id: savedImage.versionId,
      type: "generate",
      userSpeechText: userPrompt,
      systemUnderstanding: userPrompt,
      prompt: generationPrompt,
      imagePath: savedImage.imageUrl,
      params,
      source,
      createdAt: new Date().toISOString()
    },
    elapsedMs: Date.now() - startedAt
  });
}

async function serveOutput(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const outputPath = decodeURIComponent(requestUrl.pathname.replace(/^\/outputs\/+/, ""));
  const filePath = resolve(outputsDir, outputPath);
  const relativePath = relative(outputsDir, filePath);

  if (relativePath.startsWith("..") || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    const contentType = mimeTypes[extname(filePath)] || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const staticPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(publicDir, staticPath);
  const relativePath = relative(publicDir, filePath);

  if (relativePath.startsWith("..") || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    const contentType = mimeTypes[extname(filePath)] || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url?.startsWith("/api/health")) {
      sendJson(response, 200, { ok: true, service: "drawtalk" });
      return;
    }

    if (request.url?.startsWith("/api/transcribe")) {
      await handleTranscribe(request, response);
      return;
    }

    if (request.url?.startsWith("/api/command")) {
      await handleCommand(request, response);
      return;
    }

    if (request.url?.startsWith("/api/generate-image")) {
      await handleGenerateImage(request, response);
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/outputs/")) {
      await serveOutput(request, response);
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`Drawtalk MVP is running at http://localhost:${port}`);
});
