import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const maxAudioBytes = 25 * 1024 * 1024;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

      const key = trimmed.slice(0, equalsIndex).trim();
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

async function readRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.byteLength;

    if (totalBytes > maxAudioBytes) {
      const error = new Error("Audio file is too large");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
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

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const staticPath = normalizedPath === "/" ? "/index.html" : normalizedPath;
  const filePath = resolve(join(publicDir, staticPath));

  if (relative(publicDir, filePath).startsWith("..")) {
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

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`Drawtalk MVP is running at http://localhost:${port}`);
});
