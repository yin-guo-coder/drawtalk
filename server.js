import { createServer } from "node:http";
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

function getOpenAIProxyUrl() {
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

async function postJson(url, body, headers = {}) {
  const proxyUrl = getOpenAIProxyUrl();
  const requestUrl = new URL(url);
  const bodyText = JSON.stringify(body);

  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(requestUrl, {
      method: "POST",
      agent: proxyUrl ? createHttpsProxyAgent(proxyUrl) : undefined,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyText),
        ...headers
      },
      timeout: 120000
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
          payload
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("OpenAI request timed out"));
    });
    request.on("error", rejectRequest);
    request.end(bodyText);
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

async function transcribeWithOpenAI(audioBuffer, contentType) {
  if (process.env.MOCK_TRANSCRIPT) {
    return {
      text: process.env.MOCK_TRANSCRIPT,
      source: "mock"
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("Missing OPENAI_API_KEY. Add it to .env before transcribing.");
    error.statusCode = 503;
    throw error;
  }

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
  const language = process.env.TRANSCRIBE_LANGUAGE || "zh";
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

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: formData
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload.error?.message || "OpenAI transcription failed";
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  return {
    text: payload.text || "",
    source: "openai",
    model
  };
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
  const result = await transcribeWithOpenAI(audioBuffer, contentType);

  sendJson(response, 200, {
    ok: true,
    text: result.text,
    source: result.source,
    model: result.model,
    bytes: audioBuffer.byteLength,
    elapsedMs: Date.now() - startedAt
  });
}

function parseAspectRatio(prompt) {
  const normalizedPrompt = String(prompt || "").toLowerCase();

  if (/16\s*[:：比]\s*9|横版|横图|宽屏|电脑壁纸|banner/.test(normalizedPrompt)) {
    return {
      label: "16:9",
      size: "1536x1024"
    };
  }

  if (/9\s*[:：比]\s*16|竖版|竖图|手机壁纸|故事|海报/.test(normalizedPrompt)) {
    return {
      label: "9:16",
      size: "1024x1536"
    };
  }

  if (/3\s*[:：比]\s*4|小红书|封面/.test(normalizedPrompt)) {
    return {
      label: "3:4",
      size: "1024x1536"
    };
  }

  if (/4\s*[:：比]\s*3/.test(normalizedPrompt)) {
    return {
      label: "4:3",
      size: "1536x1024"
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

async function saveGeneratedImage({ imageBase64, extension = "png" }) {
  const versionId = nextVersionId;
  nextVersionId += 1;
  const fileName = `version-${versionId}.${extension}`;
  const imagePath = resolve(outputsDir, fileName);

  await mkdir(outputsDir, { recursive: true });
  await writeFile(imagePath, Buffer.from(imageBase64, "base64"));

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
  const params = {
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    size: aspectRatio.size,
    n: 1,
    aspectRatio: aspectRatio.label
  };
  let savedImage;
  let source = "openai";

  try {
    const generated = await generateImageWithOpenAI({
      prompt: generationPrompt,
      size: aspectRatio.size
    });

    params.model = generated.model;
    savedImage = await saveGeneratedImage({ imageBase64: generated.imageBase64 });
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
