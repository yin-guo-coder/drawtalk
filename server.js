import { createServer, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { basename, extname, relative, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const outputsDir = resolve(__dirname, "outputs");
const versionsFile = resolve(outputsDir, "versions.json");
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

async function readVersionRecords() {
  try {
    const content = await readFile(versionsFile, "utf8");
    const parsed = JSON.parse(content);
    const versions = Array.isArray(parsed) ? parsed : parsed.versions;

    return Array.isArray(versions) ? versions.filter((version) => version && typeof version === "object") : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeVersionRecords(versions) {
  await mkdir(outputsDir, { recursive: true });
  await writeFile(versionsFile, `${JSON.stringify(versions, null, 2)}\n`, "utf8");
}

async function clearVersionRecords() {
  nextVersionId = 1;
  await writeVersionRecords([]);
}

async function allocateVersionId() {
  const versions = await readVersionRecords();
  const largestPersistedId = versions.reduce((largestId, version) => {
    const id = Number(version.id);
    return Number.isFinite(id) && id > largestId ? id : largestId;
  }, 0);

  nextVersionId = Math.max(nextVersionId, largestPersistedId + 1);

  const versionId = nextVersionId;
  nextVersionId += 1;
  return versionId;
}

async function appendVersionRecord(version) {
  const versions = await readVersionRecords();
  const nextVersions = [
    version,
    ...versions.filter((savedVersion) => Number(savedVersion.id) !== Number(version.id))
  ];

  await writeVersionRecords(nextVersions);
  return version;
}

async function handleVersions(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    versions: await readVersionRecords()
  });
}

async function handleVersionReset(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  await clearVersionRecords();
  sendJson(response, 200, {
    ok: true,
    versions: []
  });
}

function getVersionById(versions, versionId) {
  const normalizedId = Number(versionId);
  return versions.find((version) => Number(version.id) === normalizedId);
}

function getPreviousVersion(versions, currentVersionId) {
  const sortedVersions = [...versions]
    .filter((version) => Number.isFinite(Number(version.id)))
    .sort((left, right) => Number(left.id) - Number(right.id));

  if (sortedVersions.length < 2) {
    return undefined;
  }

  const normalizedCurrentId = Number(currentVersionId);

  if (Number.isFinite(normalizedCurrentId)) {
    const currentIndex = sortedVersions.findIndex((version) => Number(version.id) === normalizedCurrentId);

    if (currentIndex > 0) {
      return sortedVersions[currentIndex - 1];
    }
  }

  return sortedVersions[sortedVersions.length - 2];
}

async function handleVersionRestore(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const payload = await readJsonBody(request);
  const versions = await readVersionRecords();
  const version = payload.target === "previous"
    ? getPreviousVersion(versions, payload.currentVersionId)
    : getVersionById(versions, payload.targetVersionId);

  if (!version) {
    sendJson(response, 404, { error: "没有找到要回退的版本" });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    version,
    versions
  });
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
  return String(process.env.ASR_PROVIDER || process.env.TRANSCRIBE_PROVIDER || "mimo").trim().toLowerCase();
}

function getSpeakerAnalysisProvider() {
  return String(process.env.SPEAKER_ANALYSIS_PROVIDER || "audeering").trim().toLowerCase();
}

function getAudeeringBaseUrl() {
  return (process.env.AUDEERING_API_URL || "https://audeering-speech-analysis.hf.space").replace(/\/+$/u, "");
}

function getAudeeringTimeoutMs() {
  return Number(process.env.AUDEERING_TIMEOUT_MS || 180000);
}

function getAudeeringDirectApiUrl() {
  const endpoint = String(process.env.AUDEERING_API_URL || "").trim();

  if (!endpoint) {
    return "";
  }

  try {
    const url = new URL(endpoint);
    return url.pathname && url.pathname !== "/" ? endpoint : "";
  } catch {
    return endpoint;
  }
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

function extractLabelLikeValue(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value.label === "string") {
    return value.label.trim();
  }

  if (Array.isArray(value.confidences)) {
    const bestConfidence = value.confidences
      .filter((item) => typeof item?.label === "string")
      .sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))[0];

    return bestConfidence?.label?.trim() || "";
  }

  if (Array.isArray(value)) {
    return value.map(extractLabelLikeValue).find(Boolean) || "";
  }

  if (typeof value === "object") {
    const numericEntry = Object.entries(value)
      .filter(([, entryValue]) => typeof entryValue === "number")
      .sort((left, right) => right[1] - left[1])[0];

    if (numericEntry) {
      return numericEntry[0];
    }
  }

  return "";
}

function extractDimensionEmotion(payload) {
  const arousal = findFirstString(payload, ["arousal", "activation"]);
  const dominance = findFirstString(payload, ["dominance"]);
  const valence = findFirstString(payload, ["valence"]);
  const dimensions = [
    arousal ? `arousal:${arousal}` : "",
    dominance ? `dominance:${dominance}` : "",
    valence ? `valence:${valence}` : ""
  ].filter(Boolean);

  return dimensions.join(" / ");
}

function extractAudeeringSpeaker(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const directEmotion = findFirstString(payload, ["emotion", "speechEmotion", "speech_emotion"]);
  const dimensionEmotion = extractDimensionEmotion(payload);
  const expressionOutput = data[2];

  return {
    age: normalizeSpeechAttribute(
      findFirstString(payload, ["age", "ageGroup", "age_group"])
      || extractLabelLikeValue(data[0])
    ),
    gender: normalizeSpeechAttribute(
      findFirstString(payload, ["gender", "speakerGender", "speaker_gender"])
      || extractLabelLikeValue(data[1])
    ),
    emotion: normalizeSpeechAttribute(
      directEmotion
      || dimensionEmotion
      || extractLabelLikeValue(expressionOutput)
      || (expressionOutput ? "expression dimensions" : "")
    )
  };
}

async function callAudeeringDirectEndpoint(audioBuffer, contentType) {
  const endpoint = getAudeeringDirectApiUrl();

  if (!endpoint) {
    return undefined;
  }

  const fileName = getAudioFileName(contentType);
  const formData = new FormData();
  formData.append("file", new File([audioBuffer], fileName, {
    type: contentType || "audio/webm"
  }));

  const apiResponse = await postFormData(endpoint, formData);

  if (!apiResponse.ok) {
    const message = apiResponse.payload.error?.message
      || apiResponse.payload.error
      || apiResponse.payload.message
      || "audEERING speaker analysis endpoint failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  return extractAudeeringSpeaker(apiResponse.payload);
}

async function callAudeeringGradioSpace(audioBuffer, contentType) {
  const baseUrl = getAudeeringBaseUrl();
  const fileName = getAudioFileName(contentType);
  const uploadPaths = [
    { prefix: "/gradio_api", path: "/gradio_api/upload" },
    { prefix: "", path: "/upload" }
  ];
  let uploadResult;
  let uploadError;

  for (const uploadPath of uploadPaths) {
    const formData = new FormData();
    formData.append("files", new File([audioBuffer], fileName, {
      type: contentType || "audio/webm"
    }));

    const uploadResponse = await postFormData(`${baseUrl}${uploadPath.path}`, formData);

    if (uploadResponse.ok) {
      uploadResult = {
        prefix: uploadPath.prefix,
        payload: uploadResponse.payload
      };
      break;
    }

    uploadError = uploadResponse.payload.error?.message
      || uploadResponse.payload.error
      || uploadResponse.payload.message
      || `audEERING speaker analysis audio upload failed: ${uploadPath.path}`;
  }

  if (!uploadResult) {
    const error = new Error(uploadError || "audEERING speaker analysis audio upload failed");
    error.statusCode = 502;
    throw error;
  }

  const audioFile = getGradioUploadedFile(uploadResult.payload, fileName, contentType, audioBuffer);
  const data = [audioFile];
  const endpoints = [
    process.env.AUDEERING_GRADIO_API,
    "recognize",
    "predict"
  ].filter(Boolean).filter((endpoint, index, allEndpoints) => allEndpoints.indexOf(endpoint) === index);
  const callPrefixes = [
    uploadResult.prefix,
    uploadResult.prefix === "/gradio_api" ? "" : "/gradio_api"
  ];
  let lastError;

  for (const endpoint of endpoints) {
    for (const prefix of callPrefixes) {
      try {
        const callBaseUrl = `${baseUrl}${prefix}/call/${endpoint}`;
        const createResponse = await postJson(callBaseUrl, { data });

        if (!createResponse.ok) {
          throw new Error(createResponse.payload.error?.message || createResponse.payload.error || createResponse.payload.message || `audEERING analysis call failed: ${prefix}/call/${endpoint}`);
        }

        const eventId = createResponse.payload.event_id || createResponse.payload.hash;

        if (eventId) {
          const resultResponse = await requestRaw(`${callBaseUrl}/${eventId}`, {
            timeoutMs: getAudeeringTimeoutMs()
          });

          if (!resultResponse.ok) {
            throw new Error(resultResponse.payload.error?.message || resultResponse.payload.error || resultResponse.payload.message || `audEERING analysis result failed: ${prefix}/call/${endpoint}`);
          }

          return extractAudeeringSpeaker({
            data: extractGradioEventPayload(resultResponse.text)
          });
        }

        return extractAudeeringSpeaker(createResponse.payload);
      } catch (error) {
        lastError = error;
      }
    }
  }

  const legacyResponse = await postJson(`${baseUrl}/api/predict`, {
    data,
    fn_index: 0
  });

  if (!legacyResponse.ok) {
    const message = legacyResponse.payload.error?.message
      || legacyResponse.payload.error
      || legacyResponse.payload.message
      || lastError?.message
      || "audEERING speaker analysis failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  return extractAudeeringSpeaker(legacyResponse.payload);
}

async function analyzeWithAudeering(audioBuffer, contentType) {
  return await callAudeeringDirectEndpoint(audioBuffer, contentType)
    || await callAudeeringGradioSpace(audioBuffer, contentType);
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

async function analyzeSpeaker(audioBuffer, contentType) {
  const provider = getSpeakerAnalysisProvider();

  if (!provider || provider === "none" || provider === "off") {
    return {};
  }

  if (provider === "audeering") {
    return analyzeWithAudeering(audioBuffer, contentType);
  }

  const error = new Error(`Unsupported speaker analysis provider: ${provider}`);
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
    bytes: audioBuffer.byteLength,
    elapsedMs: Date.now() - startedAt
  });
}

async function handleAnalyzeSpeaker(request, response) {
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
  const speaker = await analyzeSpeaker(audioBuffer, contentType);

  sendJson(response, 200, {
    ok: true,
    speaker,
    gender: speaker.gender || "",
    age: speaker.age || "",
    emotion: speaker.emotion || "",
    speakerAnalysisSource: getSpeakerAnalysisProvider(),
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

function normalizeSpeakerField(value) {
  return String(value || "").trim();
}

function getPersonalizedAgeGroup(speaker = {}) {
  const ageText = normalizeSpeakerField(speaker.age || speaker.ageGroup || speaker.speakerAge);
  const lowerAge = ageText.toLowerCase();

  if (/child|kid|children|儿童|小孩/u.test(lowerAge)) {
    return "child";
  }

  if (/teen|adolescent|少年|青少年/u.test(lowerAge)) {
    return "teen";
  }

  if (/middle|中年/u.test(lowerAge)) {
    return "middle";
  }

  if (/senior|elder|old|老年/u.test(lowerAge)) {
    return "senior";
  }

  const ageMatch = ageText.match(/(\d{1,3})/u);

  if (!ageMatch) {
    return "unknown";
  }

  const age = Number(ageMatch[1]);

  if (age <= 12) {
    return "child";
  }

  if (age <= 17) {
    return "teen";
  }

  if (age <= 35) {
    return "young";
  }

  if (age <= 59) {
    return "middle";
  }

  return "senior";
}

function getPersonalizedGenderGroup(speaker = {}) {
  const genderText = normalizeSpeakerField(speaker.gender || speaker.speakerGender).toLowerCase();

  if (/female|woman|girl|女性|女生|女/u.test(genderText)) {
    return "female";
  }

  if (/(^|[^a-z])male([^a-z]|$)|man|boy|男性|男生|男/u.test(genderText)) {
    return "male";
  }

  return "unknown";
}

function getPersonalizedEmotionGroup(speaker = {}) {
  const emotionText = normalizeSpeakerField(speaker.emotion || speaker.speechEmotion).toLowerCase();

  if (!emotionText || /unknown|expression dimensions|未识别|不确定/u.test(emotionText)) {
    return "unknown";
  }

  if (/happy|joy|excited|positive|开心|高兴|愉快/u.test(emotionText)) {
    return "happy";
  }

  if (/calm|neutral|平静|正常|自然/u.test(emotionText)) {
    return "calm";
  }

  if (/anxious|nervous|urgent|焦急|着急|紧张/u.test(emotionText)) {
    return "anxious";
  }

  if (/sad|sadness|frustrated|upset|depress|沮丧|难过|失落/u.test(emotionText)) {
    return "sad";
  }

  if (/angry|anger|irritated|mad|生气|愤怒|烦躁/u.test(emotionText)) {
    return "angry";
  }

  if (/tired|fatigue|sleepy|疲惫|疲劳|困/u.test(emotionText)) {
    return "tired";
  }

  return "unknown";
}

function stripLeadingTone(text) {
  return String(text || "").replace(/^(好的|已收到需求|已收到|太好了|别急|没关系|我明白你的意思)[，,。]*/u, "");
}

function applyEmotionTone(text, speaker) {
  const coreText = stripLeadingTone(text);

  switch (getPersonalizedEmotionGroup(speaker)) {
    case "happy":
      return `太好了，${coreText}`;
    case "anxious":
      return `别急，${coreText}`;
    case "sad":
      return `没关系，${coreText}`;
    case "angry":
      return `我明白你的意思，${coreText}`;
    case "tired":
      return `好的，${coreText}`;
    default:
      return text;
  }
}

function getPersonalizedOpening(speaker, mode = "generate") {
  const ageGroup = getPersonalizedAgeGroup(speaker);
  const genderGroup = getPersonalizedGenderGroup(speaker);
  const openings = {
    generate: {
      child: {
        male: "小画家，我先帮你把颜色和细节整理清楚。",
        female: "小画家，我先帮你把画面整理得更可爱。",
        unknown: "小画家，别着急，我先确认一下你想画的内容。"
      },
      teen: {
        male: "少年画师，我先帮你把画面细节整理好。",
        female: "少年创作者，我先帮你把画面调得更好看。",
        unknown: "少年创作者，我先帮你优化一下画面细节。"
      },
      young: {
        male: "好的，我会尽量保留你的创意并整理画面效果。",
        female: "好的，我会帮你把风格和细节整理得更完整。",
        unknown: "好的，我会根据你的描述整理画面。"
      },
      middle: {
        male: "已收到需求，我会重点确认画面清晰、稳定、符合你的描述。",
        female: "已收到需求，我会帮你把画面描述整理得更自然、完整。",
        unknown: "已收到需求，我正在整理画面细节。"
      },
      senior: {
        male: "好的，我先为您确认图片需求，稍后会为您说明画面内容。",
        female: "好的，我先为您确认图片需求，稍后会帮您描述生成结果。",
        unknown: "好的，我先确认图片需求，稍后会用语音为您说明结果。"
      },
      unknown: {
        unknown: "已收到，我正在根据你的描述整理画面。"
      }
    },
    revision: {
      unknown: {
        unknown: "已收到，我会按新的描述重新整理画面。"
      }
    },
    generating: {
      child: {
        male: "小画家，图片马上就画好啦，我正在帮你把颜色和细节变得更漂亮。",
        female: "小画家，图片马上就画好啦，我正在帮你把画面变得更可爱。",
        unknown: "小画家，别着急，图片马上就准备好啦。"
      },
      teen: {
        male: "少年画师，图片马上就弄好了，别急，我正在帮你处理细节。",
        female: "少年创作者，图片马上就完成啦，我正在帮你把画面调得更好看。",
        unknown: "少年创作者，图片马上生成完成，我正在优化最后的细节。"
      },
      young: {
        male: "好的，图片正在生成中，我会尽量保留你的创意并优化画面效果。",
        female: "好的，图片正在生成中，我会帮你把风格和细节处理得更完整。",
        unknown: "好的，图片正在生成中，我会根据你的描述优化画面。"
      },
      middle: {
        male: "已收到需求，图片正在生成中，我会重点保证画面清晰、稳定、符合你的描述。",
        female: "已收到需求，图片正在生成中，我会帮你把画面调整得更自然、完整。",
        unknown: "已收到需求，图片正在生成中，请稍等，我正在处理画面细节。"
      },
      senior: {
        male: "好的，我正在为您生成图片，请稍等一下，完成后我会为您说明画面内容。",
        female: "好的，我正在为您生成图片，请稍等一下，完成后我会帮您描述生成结果。",
        unknown: "好的，图片正在生成中，请稍等，我会用语音为您说明结果。"
      },
      unknown: {
        unknown: "已确认，开始生成图片。"
      }
    },
    reject: {
      unknown: {
        unknown: "好的，已取消。请重新说出你想生成的画面。"
      }
    }
  };
  const modeOpenings = openings[mode] || openings.generate;
  const ageOpenings = modeOpenings[ageGroup] || modeOpenings.unknown || openings.generate.unknown;
  const opening = ageOpenings[genderGroup] || ageOpenings.unknown || openings.generate.unknown.unknown;

  return applyEmotionTone(opening, speaker);
}

function buildGenerateReply(command, speaker) {
  const avoidText = command.mustAvoid.length ? `避免${command.mustAvoid.join("、")}。` : "";
  return `${getPersonalizedOpening(speaker, "generate")}我理解为：生成一张${command.subject}，风格是${command.style}，画幅为${command.aspectRatio}。${avoidText}是否确认？`;
}

function buildRevisedReply(command, speaker) {
  return `${getPersonalizedOpening(speaker, "revision")}我已改成：${command.subject}，风格是${command.style}，画幅为${command.aspectRatio}。是否确认？`;
}

function buildConfirmReply(speaker) {
  return getPersonalizedOpening(speaker, "generating");
}

function buildRejectReply(speaker) {
  return getPersonalizedOpening(speaker, "reject");
}

function parseChineseVersionNumber(value) {
  const text = String(value || "").trim();

  if (/^\d+$/u.test(text)) {
    return Number(text);
  }

  const digits = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };

  if (digits[text]) {
    return digits[text];
  }

  if (text === "十") {
    return 10;
  }

  const tenMatch = text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);

  if (!tenMatch) {
    return undefined;
  }

  const tens = tenMatch[1] ? digits[tenMatch[1]] : 1;
  const ones = tenMatch[2] ? digits[tenMatch[2]] : 0;
  return tens * 10 + ones;
}

function parseVersionRestoreCommand(text) {
  const normalizedText = String(text || "").trim();
  const hasRestoreVerb = includesAny(normalizedText, ["回到", "返回", "切回", "恢复到", "回退到", "退回"]);

  if (hasRestoreVerb && includesAny(normalizedText, ["上一版", "上一个版本", "前一版", "前一个版本"])) {
    return {
      intent: "restore_version",
      versionTarget: "previous",
      needConfirmation: false,
      replyToUser: "好的，正在切回上一版。"
    };
  }

  if (!hasRestoreVerb) {
    return undefined;
  }

  const versionMatch = normalizedText.match(/第\s*([0-9一二两三四五六七八九十]+)\s*(?:版|个版本)/u)
    || normalizedText.match(/([0-9一二两三四五六七八九十]+)\s*(?:版|个版本)/u);
  const targetVersionId = parseChineseVersionNumber(versionMatch?.[1]);

  if (!targetVersionId) {
    return undefined;
  }

  return {
    intent: "restore_version",
    targetVersionId,
    needConfirmation: false,
    replyToUser: `好的，正在切回版本 ${targetVersionId}。`
  };
}

function parseVersionContinueCommand(text) {
  const normalizedText = String(text || "").trim();
  const hasContinueIntent = includesAny(normalizedText, ["继续改", "继续修改", "接着改", "接着修改", "基于"]);

  if (!hasContinueIntent || !includesAny(normalizedText, ["版", "版本"])) {
    return undefined;
  }

  if (includesAny(normalizedText, ["上一版", "上一个版本", "前一版", "前一个版本"])) {
    return {
      intent: "continue_from_version",
      versionTarget: "previous",
      needConfirmation: false,
      replyToUser: "好的，正在切回上一版，之后可以继续修改。"
    };
  }

  const versionMatch = normalizedText.match(/第\s*([0-9一二两三四五六七八九十]+)\s*(?:版|个版本)/u)
    || normalizedText.match(/([0-9一二两三四五六七八九十]+)\s*(?:版|个版本)/u);
  const targetVersionId = parseChineseVersionNumber(versionMatch?.[1]);

  if (!targetVersionId) {
    return undefined;
  }

  return {
    intent: "continue_from_version",
    targetVersionId,
    needConfirmation: false,
    replyToUser: `好的，正在切到版本 ${targetVersionId}，之后可以继续修改。`
  };
}

function buildGenerateCommand(text, previousCommand, speaker) {
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
  command.replyToUser = buildGenerateReply(command, speaker);
  return command;
}

function buildRevisedCommand(text, previousCommand, speaker) {
  const revision = text.replace(/^(改成|换成|调整为|改为|变成|不对，?|不是，?)/u, "").trim();
  const baseText = [previousCommand?.subject, revision].filter(Boolean).join("，");
  const command = buildGenerateCommand(baseText || text, previousCommand, speaker);

  command.intent = "generate";
  command.userRevision = text;
  command.replyToUser = buildRevisedReply(command, speaker);
  return command;
}

const editActionKeywords = [
  "更换",
  "更改",
  "替换",
  "换",
  "换成",
  "换为",
  "换掉",
  "改",
  "改成",
  "改为",
  "改换",
  "改掉",
  "改一下",
  "修改成",
  "修改为",
  "修改一下",
  "调",
  "调整为",
  "调整成",
  "调成",
  "变成",
  "变为",
  "重绘",
  "重画",
  "局部重绘",
  "局部修改",
  "删除",
  "删掉",
  "去掉",
  "去除",
  "移除",
  "擦掉",
  "不要"
];

const editTargetKeywords = [
  "背景",
  "底色",
  "环境",
  "天空",
  "地面",
  "左边",
  "左侧",
  "右边",
  "右侧",
  "上方",
  "顶部",
  "下面",
  "下方",
  "底部",
  "衣服",
  "上衣",
  "裙子",
  "裤子",
  "服装",
  "人物",
  "人像",
  "角色",
  "脸",
  "头发",
  "主体",
  "物体"
];

function compactCommandText(text) {
  return String(text || "").replace(/[\s，。！？、,.!?；;：:]/gu, "");
}

function extractExplicitEditTarget(text) {
  const compactText = compactCommandText(text);
  const targetPatterns = [
    /(?:把|将|给|让)?(?:当前图片|这张图|图片|画面|画面里|图里|里面|其中的)?(.+?)(?:更换为|更换成|更改为|更改成|替换为|替换成|换成|换为|换掉|改成|改为|改换为|改换成|修改成|修改为|调整为|调整成|调成|变成|变为)/u,
    /(?:把|将|给|让)?(?:当前图片|这张图|图片|画面|画面里|图里|里面|其中的)?(.+?)(?:删除|删掉|去掉|去除|移除|擦掉|不要)/u,
    /(?:更换|替换|改换|更改|修改|调整|重绘|重画|换|改)(.+?)(?:为|成|到)/u,
    /(?:删除|删掉|去掉|去除|移除|擦掉|不要)(.+)$/u
  ];

  for (const pattern of targetPatterns) {
    const match = compactText.match(pattern);
    const target = match?.[1]?.trim();

    if (target) {
      return target.replace(/^(这个|那个|当前|图片的|画面的|图里的|里面的|其中的)/u, "");
    }
  }

  return "";
}

function inferEditTarget(text) {
  const normalizedText = String(text || "").trim();
  const explicitTarget = extractExplicitEditTarget(normalizedText);

  if (/背景|底色|环境/u.test(normalizedText)) {
    return { targetObject: "背景", regionType: "background", regionLabel: "背景" };
  }

  if (/左边|左侧|左下|左上/u.test(normalizedText)) {
    return { targetObject: explicitTarget || "左侧区域", regionType: "left", regionLabel: "左侧区域" };
  }

  if (/右边|右侧|右下|右上/u.test(normalizedText)) {
    return { targetObject: explicitTarget || "右侧区域", regionType: "right", regionLabel: "右侧区域" };
  }

  if (/上方|顶部|上面/u.test(normalizedText)) {
    return { targetObject: explicitTarget || "上方区域", regionType: "top", regionLabel: "上方区域" };
  }

  if (/下方|底部|下面/u.test(normalizedText)) {
    return { targetObject: explicitTarget || "下方区域", regionType: "bottom", regionLabel: "下方区域" };
  }

  if (/衣服|上衣|裙子|裤子|服装/u.test(normalizedText)) {
    return { targetObject: explicitTarget || "衣服", regionType: "person_clothing", regionLabel: "人物衣服" };
  }

  if (/人物|人像|角色|脸|头发/u.test(normalizedText)) {
    return { targetObject: explicitTarget || "人物", regionType: "person", regionLabel: "人物区域" };
  }

  return { targetObject: explicitTarget || "主体区域", regionType: "subject", regionLabel: explicitTarget || "主体区域" };
}

function inferEditType(text, editTarget) {
  const normalizedText = String(text || "").trim();

  if (/删除|删掉|去掉|移除|不要/u.test(normalizedText)) {
    return "remove_object";
  }

  if (editTarget.regionType === "background" || /背景|底色|环境/u.test(normalizedText)) {
    return "replace_background";
  }

  if (/颜色|换色|改色/u.test(normalizedText)) {
    return "recolor_object";
  }

  return "local_redraw";
}

function buildEditReply(command, speaker) {
  const keepText = command.mustKeep.length ? `，并保留${command.mustKeep.join("、")}不变` : "";
  return `${getPersonalizedOpening(speaker, "revision")}我理解为：局部重绘${command.inpaintRegion.label}，${command.instruction}${keepText}。是否确认？`;
}

function buildEditCommand(text, currentVersionId, speaker) {
  const editTarget = inferEditTarget(text);
  const editType = inferEditType(text, editTarget);
  const mustKeep = [];

  if (/人物不要变|人不要变|主体不要变|保持人物|保留人物/u.test(text)) {
    mustKeep.push("人物");
  }

  const command = {
    intent: "edit",
    targetVersionId: Number(currentVersionId),
    editType,
    targetObject: editTarget.targetObject,
    instruction: text,
    mustKeep,
    needConfirmation: true,
    inpaintRegion: {
      type: editTarget.regionType,
      label: editTarget.regionLabel
    }
  };

  command.replyToUser = buildEditReply(command, speaker);
  return command;
}

function looksLikeEditCommand(text, currentVersionId) {
  if (!Number.isFinite(Number(currentVersionId))) {
    return false;
  }

  const compactText = compactCommandText(text);
  const hasEditAction = includesAny(compactText, editActionKeywords);
  const hasEditTarget = includesAny(compactText, editTargetKeywords);
  const hasExplicitChangePattern = /(?:把|将|给|让).+?(?:更换为|更换成|更改为|更改成|替换为|替换成|换成|换为|改成|改为|改换为|改换成|修改成|修改为|调整为|调整成|变成|变为)/u.test(compactText);
  const hasActionFirstChangePattern = /(?:更换|替换|改换|更改|修改|调整|重绘|重画|换|改).+?(?:为|成|到)/u.test(compactText);

  return hasExplicitChangePattern || hasActionFirstChangePattern || (hasEditAction && hasEditTarget);
}

function parseCommand(text, previousCommand, speaker = {}, currentVersionId) {
  const normalizedText = String(text || "").trim();

  if (!normalizedText) {
    const error = new Error("Command text is required");
    error.statusCode = 400;
    throw error;
  }

  const versionContinueCommand = parseVersionContinueCommand(normalizedText);

  if (versionContinueCommand) {
    return versionContinueCommand;
  }

  const versionRestoreCommand = parseVersionRestoreCommand(normalizedText);

  if (versionRestoreCommand) {
    return versionRestoreCommand;
  }

  if (includesAny(normalizedText, ["确认", "可以", "没问题", "对", "开始生成", "就这样"]) && !includesAny(normalizedText, ["不对", "不是", "不要"])) {
    return {
      intent: "confirm",
      needConfirmation: false,
      replyToUser: previousCommand ? buildConfirmReply(speaker) : "还没有待确认的需求，请先说出想生成的画面。"
    };
  }

  if (includesAny(normalizedText, ["不对", "不是", "取消", "重新说", "先别生成"])) {
    return {
      intent: "reject",
      needConfirmation: false,
      replyToUser: buildRejectReply(speaker)
    };
  }

  if (previousCommand && includesAny(normalizedText, ["改成", "换成", "调整为", "改为", "变成"])) {
    return buildRevisedCommand(normalizedText, previousCommand, speaker);
  }

  if (looksLikeEditCommand(normalizedText, currentVersionId)) {
    return buildEditCommand(normalizedText, currentVersionId, speaker);
  }

  return buildGenerateCommand(normalizedText, previousCommand, speaker);
}

async function handleCommand(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const payload = await readJsonBody(request);
  const commandText = normalizeTranscriptForImagePrompt(payload.text);
  const command = parseCommand(commandText, payload.previousCommand, payload.speaker, payload.currentVersionId);

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
  const versionId = await allocateVersionId();
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
  const versionId = await allocateVersionId();
  const fileName = `version-${versionId}.svg`;
  const imagePath = resolve(outputsDir, fileName);

  await mkdir(outputsDir, { recursive: true });
  await writeFile(imagePath, buildLocalPreviewSvg(prompt, aspectRatio), "utf8");

  return {
    versionId,
    imageUrl: `/outputs/${fileName}`
  };
}

function getRegionBox(regionType) {
  const boxes = {
    background: { x: 0.04, y: 0.05, width: 0.92, height: 0.9 },
    left: { x: 0.04, y: 0.08, width: 0.42, height: 0.84 },
    right: { x: 0.54, y: 0.08, width: 0.42, height: 0.84 },
    top: { x: 0.08, y: 0.06, width: 0.84, height: 0.38 },
    bottom: { x: 0.08, y: 0.56, width: 0.84, height: 0.38 },
    person: { x: 0.32, y: 0.15, width: 0.36, height: 0.72 },
    person_clothing: { x: 0.32, y: 0.38, width: 0.36, height: 0.34 },
    subject: { x: 0.28, y: 0.22, width: 0.44, height: 0.56 }
  };

  return boxes[regionType] || boxes.subject;
}

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

function getCrc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  const crcBuffer = Buffer.alloc(4);

  lengthBuffer.writeUInt32BE(data.length, 0);
  crcBuffer.writeUInt32BE(getCrc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function encodeRgbaPng(width, height, pixels) {
  const scanlineLength = width * 4 + 1;
  const raw = Buffer.alloc(scanlineLength * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * scanlineLength] = 0;
    pixels.copy(raw, y * scanlineLength + 1, y * width * 4, (y + 1) * width * 4);
  }

  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    header,
    createPngChunk("IHDR", ihdr),
    createPngChunk("IDAT", deflateSync(raw)),
    createPngChunk("IEND")
  ]);
}

function createRegionMaskPngBase64(width, height, regionType) {
  const box = getRegionBox(regionType);
  const startX = Math.max(0, Math.round(width * box.x));
  const startY = Math.max(0, Math.round(height * box.y));
  const endX = Math.min(width, Math.round(width * (box.x + box.width)));
  const endY = Math.min(height, Math.round(height * (box.y + box.height)));
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const inRegion = x >= startX && x <= endX && y >= startY && y <= endY;
      const value = inRegion ? 255 : 0;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }

  return encodeRgbaPng(width, height, pixels).toString("base64");
}

function getAspectRatioDimensionsFromVersion(version) {
  const sizeText = String(version?.params?.size || "");
  const sizeMatch = sizeText.match(/(\d{2,5})x(\d{2,5})/u);

  if (sizeMatch) {
    return {
      width: Number(sizeMatch[1]),
      height: Number(sizeMatch[2])
    };
  }

  const aspectRatioText = String(version?.params?.aspectRatio || "1:1");
  const ratioMatch = aspectRatioText.match(/(\d{1,3})\s*:\s*(\d{1,3})/u);

  if (ratioMatch) {
    const widthRatio = Number(ratioMatch[1]);
    const heightRatio = Number(ratioMatch[2]);
    const longEdge = 1024;

    if (widthRatio >= heightRatio) {
      return {
        width: longEdge,
        height: Math.round(longEdge * heightRatio / widthRatio)
      };
    }

    return {
      width: Math.round(longEdge * widthRatio / heightRatio),
      height: longEdge
    };
  }

  return { width: 1024, height: 1024 };
}

function resolveOutputImagePath(imageUrl = "") {
  const fileName = basename(String(imageUrl).split("?")[0]);
  const filePath = resolve(outputsDir, fileName);
  const relativePath = relative(outputsDir, filePath);

  if (relativePath.startsWith("..") || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    return undefined;
  }

  return filePath;
}

async function getVersionImageDataHref(version) {
  const imagePath = resolveOutputImagePath(version?.imagePath);

  if (!imagePath) {
    return "";
  }

  try {
    const imageBuffer = await readFile(imagePath);
    const imageExtension = extname(imagePath).toLowerCase();
    const contentType = mimeTypes[imageExtension] || "image/png";
    return `data:${contentType};base64,${imageBuffer.toString("base64")}`;
  } catch {
    return "";
  }
}

function buildEditPrompt(command, sourceVersion) {
  return [
    sourceVersion?.prompt || sourceVersion?.systemUnderstanding || sourceVersion?.userSpeechText || "",
    `局部重绘区域：${command.inpaintRegion?.label || command.targetObject || "主体区域"}`,
    `修改要求：${command.instruction}`,
    command.mustKeep?.length ? `必须保留：${command.mustKeep.join("、")}` : "",
    "Keep the unchanged area consistent with the source image."
  ].filter(Boolean).join("\n");
}

async function buildLocalEditPreviewSvg({ sourceVersion, command }) {
  const dimensions = getAspectRatioDimensionsFromVersion(sourceVersion);
  const region = command.inpaintRegion || {};
  const box = getRegionBox(region.type);
  const sourceDataHref = await getVersionImageDataHref(sourceVersion);
  const label = escapeSvgText(region.label || command.targetObject || "局部区域");
  const instruction = escapeSvgText(command.instruction || "");
  const rectX = Math.round(dimensions.width * box.x);
  const rectY = Math.round(dimensions.height * box.y);
  const rectWidth = Math.round(dimensions.width * box.width);
  const rectHeight = Math.round(dimensions.height * box.height);
  const imageLayer = sourceDataHref
    ? `<image href="${sourceDataHref}" x="0" y="0" width="${dimensions.width}" height="${dimensions.height}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect width="100%" height="100%" fill="#12243a"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}">
  <defs>
    <filter id="softShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#06101c" flood-opacity="0.32"/>
    </filter>
  </defs>
  ${imageLayer}
  <rect width="100%" height="100%" fill="#06101c" opacity="0.18"/>
  <rect x="${rectX}" y="${rectY}" width="${rectWidth}" height="${rectHeight}" rx="20" fill="#4f9dff" opacity="0.2"/>
  <rect x="${rectX}" y="${rectY}" width="${rectWidth}" height="${rectHeight}" rx="20" fill="none" stroke="#4f9dff" stroke-width="10" stroke-dasharray="28 18" filter="url(#softShadow)"/>
  <rect x="${Math.round(dimensions.width * 0.06)}" y="${Math.round(dimensions.height * 0.07)}" width="${Math.round(dimensions.width * 0.5)}" height="112" rx="18" fill="#06101c" opacity="0.74"/>
  <text x="${Math.round(dimensions.width * 0.08)}" y="${Math.round(dimensions.height * 0.07) + 40}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-size="28" fill="#8de8ff" font-weight="800">LOCAL INPAINT PREVIEW</text>
  <text x="${Math.round(dimensions.width * 0.08)}" y="${Math.round(dimensions.height * 0.07) + 82}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-size="34" fill="#ffffff" font-weight="800">${label}</text>
  <text x="${Math.round(dimensions.width * 0.08)}" y="${Math.round(dimensions.height * 0.92)}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-size="30" fill="#ffffff" font-weight="700">${instruction}</text>
</svg>`;
}

async function saveLocalEditPreviewImage({ sourceVersion, command }) {
  const versionId = await allocateVersionId();
  const fileName = `version-${versionId}.svg`;
  const imagePath = resolve(outputsDir, fileName);

  await mkdir(outputsDir, { recursive: true });
  await writeFile(imagePath, await buildLocalEditPreviewSvg({ sourceVersion, command }), "utf8");

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
  return String(process.env.HORDE_IMAGE_MODEL || "auto").trim();
}

function getHordeModels() {
  const model = getHordeModel();

  if (!model || ["auto", "any", "default", "random"].includes(model.toLowerCase())) {
    return [];
  }

  return model.split(",").map((item) => item.trim()).filter(Boolean);
}

async function generateImageWithHorde({ prompt, aspectRatio }) {
  const dimensions = getHordeDimensions(aspectRatio);
  const models = getHordeModels();
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
    r2: false
  };

  if (models.length > 0) {
    requestBody.models = models;
  }

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
        model: generation.model || models[0] || "AI Horde auto",
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

async function generateImageEditWithHorde({ prompt, sourceVersion, command }) {
  const sourceImagePath = resolveOutputImagePath(sourceVersion.imagePath);
  const sourceExtension = extname(sourceImagePath || "").toLowerCase();

  if (!sourceImagePath || ![".png", ".jpg", ".jpeg", ".webp"].includes(sourceExtension)) {
    const error = new Error("当前版本图片格式暂不支持 AI Horde 局部重绘，已使用本地预览。");
    error.statusCode = 503;
    throw error;
  }

  const dimensions = getAspectRatioDimensionsFromVersion(sourceVersion);
  const models = getHordeModels();
  const sourceImageBase64 = (await readFile(sourceImagePath)).toString("base64");
  const sourceMaskBase64 = createRegionMaskPngBase64(
    dimensions.width,
    dimensions.height,
    command.inpaintRegion?.type || "subject"
  );
  const requestBody = {
    prompt,
    params: {
      n: 1,
      width: dimensions.width,
      height: dimensions.height,
      steps: Number(process.env.HORDE_STEPS || 10),
      cfg_scale: Number(process.env.HORDE_CFG_SCALE || 7),
      denoising_strength: Number(process.env.HORDE_DENOISING_STRENGTH || 0.72)
    },
    source_image: sourceImageBase64,
    source_processing: "inpainting",
    source_mask: sourceMaskBase64,
    nsfw: false,
    trusted_workers: false,
    censor_nsfw: true,
    r2: false
  };

  if (models.length > 0) {
    requestBody.models = models;
  }

  const createResponse = await postJson(
    "https://aihorde.net/api/v2/generate/async",
    requestBody,
    getHordeHeaders()
  );

  if (!createResponse.ok) {
    const message = createResponse.payload.message || createResponse.payload.error?.message || "AI Horde image edit request failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  const generationId = createResponse.payload.id;

  if (!generationId) {
    const error = new Error("AI Horde did not return an edit generation id");
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
      const message = checkResponse.payload.message || checkResponse.payload.error?.message || "AI Horde edit status check failed";
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
        const message = statusResponse.payload.message || statusResponse.payload.error?.message || "AI Horde edit result fetch failed";
        const error = new Error(message);
        error.statusCode = 502;
        throw error;
      }

      const generation = statusResponse.payload.generations?.[0];
      const imageBase64 = normalizeImageBase64(generation?.img);

      if (!imageBase64 || generation?.censored) {
        const error = new Error(generation?.censored ? "AI Horde censored this edit" : "AI Horde did not return edited image data");
        error.statusCode = 502;
        throw error;
      }

      return {
        imageBase64,
        model: generation.model || models[0] || "AI Horde auto",
        dimensions,
        generationId
      };
    }

    const waitSeconds = Math.max(2, Math.min(Number(checkResponse.payload.wait_time || 4), 10));
    await delay(waitSeconds * 1000);
  }

  const error = new Error("AI Horde image edit timed out. Local preview was used instead.");
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

function shouldUseLocalPreviewFallback(provider, error) {
  if (provider === "openai") {
    return error.statusCode === 503;
  }

  if (provider === "horde") {
    return error.statusCode === 504 || process.env.HORDE_FALLBACK_ON_ERROR === "true";
  }

  return false;
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
    if (!shouldUseLocalPreviewFallback(provider, error)) {
      throw error;
    }

    source = "local-preview";
    params.fallbackFrom = provider;
    params.fallbackReason = error.message || "Image provider failed";
    savedImage = await saveLocalPreviewImage({
      prompt: userPrompt,
      aspectRatio
    });
  }

  const version = await appendVersionRecord({
    id: savedImage.versionId,
    type: "generate",
    userSpeechText: userPrompt,
    systemUnderstanding: userPrompt,
    prompt: generationPrompt,
    imagePath: savedImage.imageUrl,
    params,
    source,
    createdAt: new Date().toISOString()
  });

  sendJson(response, 200, {
    ok: true,
    version,
    elapsedMs: Date.now() - startedAt
  });
}

async function handleEditImage(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const payload = await readJsonBody(request);
  const command = payload.command || payload;
  const targetVersionId = Number(command.targetVersionId || payload.targetVersionId);

  if (!Number.isFinite(targetVersionId)) {
    sendJson(response, 400, { error: "Target version is required" });
    return;
  }

  const versions = await readVersionRecords();
  const sourceVersion = getVersionById(versions, targetVersionId);

  if (!sourceVersion) {
    sendJson(response, 404, { error: "没有找到要局部重绘的版本" });
    return;
  }

  const normalizedCommand = {
    intent: "edit",
    targetVersionId,
    editType: command.editType || "local_redraw",
    targetObject: command.targetObject || command.inpaintRegion?.label || "主体区域",
    instruction: String(command.instruction || "").trim(),
    mustKeep: Array.isArray(command.mustKeep) ? command.mustKeep : [],
    inpaintRegion: command.inpaintRegion || {
      type: "subject",
      label: command.targetObject || "主体区域"
    }
  };

  if (!normalizedCommand.instruction) {
    sendJson(response, 400, { error: "Edit instruction is required" });
    return;
  }

  const startedAt = Date.now();
  const prompt = buildEditPrompt(normalizedCommand, sourceVersion);
  const provider = normalizeImageProvider(payload.provider || process.env.IMAGE_PROVIDER || "horde") || "horde";
  const params = {
    provider,
    editType: normalizedCommand.editType,
    targetObject: normalizedCommand.targetObject,
    inpaintRegion: normalizedCommand.inpaintRegion,
    sourceVersionId: sourceVersion.id
  };
  let savedImage;
  let source = provider;

  try {
    if (provider === "horde") {
      const generated = await generateImageEditWithHorde({
        prompt,
        sourceVersion,
        command: normalizedCommand
      });

      params.model = generated.model;
      params.size = `${generated.dimensions.width}x${generated.dimensions.height}`;
      params.generationId = generated.generationId;
      savedImage = await saveGeneratedImage({ imageBase64: generated.imageBase64 });
    } else {
      const error = new Error("当前模型暂未接入图片编辑，已使用本地预览。");
      error.statusCode = 503;
      throw error;
    }
  } catch (error) {
    source = "local-preview";
    params.fallbackFrom = provider;
    params.fallbackReason = error.message || "Image edit provider failed";
    savedImage = await saveLocalEditPreviewImage({
      sourceVersion,
      command: normalizedCommand
    });
  }

  const version = await appendVersionRecord({
    id: savedImage.versionId,
    type: "edit",
    parentVersionId: sourceVersion.id,
    userSpeechText: normalizedCommand.instruction,
    systemUnderstanding: `局部重绘${normalizedCommand.inpaintRegion.label}：${normalizedCommand.instruction}`,
    prompt,
    imagePath: savedImage.imageUrl,
    params,
    source,
    createdAt: new Date().toISOString()
  });

  sendJson(response, 200, {
    ok: true,
    version,
    versions: await readVersionRecords(),
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

    if (request.url?.startsWith("/api/analyze-speaker")) {
      await handleAnalyzeSpeaker(request, response);
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

    if (request.url?.startsWith("/api/edit-image")) {
      await handleEditImage(request, response);
      return;
    }

    if (request.url?.startsWith("/api/versions/reset")) {
      await handleVersionReset(request, response);
      return;
    }

    if (request.url?.startsWith("/api/versions/restore")) {
      await handleVersionRestore(request, response);
      return;
    }

    if (request.url?.startsWith("/api/versions")) {
      await handleVersions(request, response);
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
