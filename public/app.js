const micButton = document.querySelector("#mic-button");
const statusChip = document.querySelector("#status-chip");
const voiceTitle = document.querySelector("#voice-title");
const voiceStatus = document.querySelector("#voice-status");
const imageFrame = document.querySelector("#image-frame");
const emptyImage = document.querySelector(".empty-image");
const understandingPanel = document.querySelector("#understanding-panel");
const understandingText = document.querySelector("#understanding-text");
const transcriptPreview = document.querySelector("#transcript-preview");
const speechInsights = document.querySelector("#speech-insights");
const speechGender = document.querySelector("#speech-gender");
const speechAge = document.querySelector("#speech-age");
const speechEmotion = document.querySelector("#speech-emotion");
const providerSelect = document.querySelector("#provider-select");
const versionList = document.querySelector("#version-list");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const statuses = {
  idle: {
    chip: "待命",
    title: "按住说话",
    message: "说出你想画的画面"
  },
  listening: {
    chip: "聆听中",
    title: "正在聆听",
    message: "松开后开始理解"
  },
  thinking: {
    chip: "理解中",
    title: "正在理解",
    message: "语音正在转成文字"
  },
  ready: {
    chip: "已识别",
    title: "转写完成",
    message: "可以继续下一次语音"
  },
  generating: {
    chip: "生成中",
    title: "正在生成",
    message: "图片生成链路待接入"
  },
  error: {
    chip: "异常",
    title: "没有听清",
    message: "请再试一次"
  }
};

let mediaStream;
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let wantsRecording = false;
let activePointerId;
let speechRecognition;
let usingBrowserSpeech = false;
let browserSpeechFinalText = "";
let browserSpeechError = "";
let passiveSpeechRecognition;
let passiveSpeechFinalText = "";
let passiveSpeechInterimText = "";
let versions = [];
let isGenerating = false;
let pendingCommand = null;

function getVersionSourceLabel(source) {
  if (source === "openai") {
    return "GPT Image 生成";
  }

  if (source === "horde") {
    return "AI Horde 生成";
  }

  return "本地预览";
}

function getProviderLabel(provider) {
  if (provider === "openai") {
    return "GPT Image";
  }

  return "AI Horde";
}

function getGenerationDoneMessage(source) {
  if (source === "local-preview") {
    return "已生成本地预览";
  }

  if (source === "horde") {
    return "AI Horde 图片已生成";
  }

  if (source === "openai") {
    return "GPT Image 图片已生成";
  }

  return "图片已生成";
}

function setStatus(state, message) {
  const nextStatus = statuses[state] || statuses.idle;
  statusChip.dataset.state = state;
  statusChip.textContent = nextStatus.chip;
  voiceTitle.textContent = nextStatus.title;
  voiceStatus.textContent = message || nextStatus.message;
}

function showTranscript(text) {
  const trimmed = text.trim();
  transcriptPreview.hidden = !trimmed;
  transcriptPreview.textContent = trimmed ? `“${trimmed}”` : "";
  understandingPanel.hidden = true;
  understandingText.textContent = "";
}

function clearSpeechInsights() {
  speechInsights.hidden = false;
  speechGender.textContent = "--";
  speechAge.textContent = "--";
  speechEmotion.textContent = "--";
}

function showSpeechInsights(payload) {
  const speaker = payload.speaker || {};
  const gender = payload.gender || speaker.gender || "";
  const age = payload.age || speaker.age || "";
  const emotion = payload.emotion || speaker.emotion || "";
  speechInsights.hidden = false;
  speechGender.textContent = gender || "--";
  speechAge.textContent = age || "--";
  speechEmotion.textContent = emotion || "--";
}

function showDialogue(userText, assistantText) {
  const lines = [];

  if (userText) {
    lines.push(`你：${userText}`);
  }

  if (assistantText) {
    lines.push(`AI：${assistantText}`);
  }

  const content = lines.join("\n");
  transcriptPreview.hidden = !content;
  transcriptPreview.textContent = content;
  understandingPanel.hidden = !assistantText;
  understandingText.textContent = assistantText || "";

  if (assistantText) {
    speakAssistantReply(assistantText);
  }
}

function speakAssistantReply(text) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

function showGeneratedImage(version) {
  let image = imageFrame.querySelector(".generated-image");

  if (!image) {
    image = document.createElement("img");
    image.className = "generated-image";
    imageFrame.prepend(image);
  }

  image.src = `${version.imagePath}?t=${Date.now()}`;
  image.alt = version.systemUnderstanding || version.userSpeechText || "生成图片";
  emptyImage.hidden = true;
  imageFrame.classList.add("has-generated-image");
}

function renderVersions(versions = []) {
  versionList.innerHTML = "";

  if (versions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "version-empty";
    empty.textContent = "暂无版本";
    versionList.append(empty);
    return;
  }

  for (const version of versions) {
    const item = document.createElement("li");
    item.className = "version-item";

    const title = document.createElement("strong");
    title.textContent = `版本 ${version.id}`;

    const detail = document.createElement("span");
    detail.textContent = version.userSpeechText || version.prompt || "等待生成";

    const meta = document.createElement("span");
    meta.textContent = [
      version.params?.aspectRatio,
      version.params?.size,
      getVersionSourceLabel(version.source)
    ].filter(Boolean).join(" · ");

    item.append(title, detail, meta);
    versionList.append(item);
  }
}

setStatus("idle");
showTranscript("");
clearSpeechInsights();
renderVersions();

window.drawtalkUi = {
  setStatus,
  showTranscript,
  renderVersions
};

function createSpeechRecognition() {
  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.addEventListener("result", (event) => {
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0]?.transcript || "";

      if (event.results[index].isFinal) {
        browserSpeechFinalText += text;
      } else {
        interimText += text;
      }
    }

    showTranscript(`${browserSpeechFinalText}${interimText}`);
  });

  recognition.addEventListener("error", (event) => {
    if (event.error !== "no-speech") {
      browserSpeechError = event.error || "语音识别失败";
      wantsRecording = false;
    }
  });

  recognition.addEventListener("end", () => {
    if (!usingBrowserSpeech) {
      return;
    }

    if (wantsRecording) {
      try {
        recognition.start();
        return;
      } catch {
        // Continue to finalize the current recognition result.
      }
    }

    usingBrowserSpeech = false;
    wantsRecording = false;
    isRecording = false;
    micButton.classList.remove("is-recording");

    const transcript = browserSpeechFinalText.trim();

    if (transcript) {
      void handleRecognizedText(transcript);
      return;
    }

    setStatus("error", browserSpeechError || "没有识别到文字");
  });

  return recognition;
}

function getPassiveSpeechTranscript() {
  return `${passiveSpeechFinalText}${passiveSpeechInterimText}`.trim();
}

function startPassiveSpeechFallback() {
  if (!SpeechRecognition || passiveSpeechRecognition) {
    return;
  }

  passiveSpeechFinalText = "";
  passiveSpeechInterimText = "";
  passiveSpeechRecognition = new SpeechRecognition();
  passiveSpeechRecognition.lang = "zh-CN";
  passiveSpeechRecognition.continuous = true;
  passiveSpeechRecognition.interimResults = true;
  passiveSpeechRecognition.maxAlternatives = 1;

  passiveSpeechRecognition.addEventListener("result", (event) => {
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0]?.transcript || "";

      if (event.results[index].isFinal) {
        passiveSpeechFinalText += text;
      } else {
        interimText += text;
      }
    }

    passiveSpeechInterimText = interimText;
    showTranscript(getPassiveSpeechTranscript());
  });

  passiveSpeechRecognition.addEventListener("error", () => {
    passiveSpeechRecognition = undefined;
  });

  passiveSpeechRecognition.addEventListener("end", () => {
    passiveSpeechRecognition = undefined;
  });

  try {
    passiveSpeechRecognition.start();
  } catch {
    passiveSpeechRecognition = undefined;
  }
}

function stopPassiveSpeechFallback() {
  if (!passiveSpeechRecognition) {
    return;
  }

  try {
    passiveSpeechRecognition.stop();
  } catch {
    passiveSpeechRecognition.abort();
  }
}

function waitForPassiveSpeechFallback(timeoutMs = 700) {
  if (!passiveSpeechRecognition) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const fallback = passiveSpeechRecognition;
    const timeout = window.setTimeout(resolve, timeoutMs);

    fallback.addEventListener("end", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

async function generateImageFromPrompt(prompt) {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt || isGenerating) {
    return;
  }

  isGenerating = true;
  micButton.disabled = true;
  providerSelect.disabled = true;
  const provider = providerSelect.value || "horde";
  setStatus("generating", `正在使用 ${getProviderLabel(provider)} 生成图片`);

  try {
    const response = await fetch("/api/generate-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: trimmedPrompt,
        provider
      })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "图片生成失败");
    }

    const version = payload.version;
    versions = [version, ...versions];
    showGeneratedImage(version);
    renderVersions(versions);
    setStatus("ready", getGenerationDoneMessage(version.source));
  } catch (error) {
    setStatus("error", error.message || "图片生成失败");
  } finally {
    isGenerating = false;
    micButton.disabled = false;
    providerSelect.disabled = false;
  }
}

async function parseVoiceCommand(text) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      previousCommand: pendingCommand
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "需求理解失败");
  }

  return payload.command;
}

async function handleRecognizedText(transcript) {
  const trimmedTranscript = transcript.trim();

  if (!trimmedTranscript) {
    setStatus("error", "没有识别到文字");
    return;
  }

  showDialogue(trimmedTranscript, "");
  setStatus("thinking", "正在理解你的需求");

  try {
    const command = await parseVoiceCommand(trimmedTranscript);
    showDialogue(trimmedTranscript, command.replyToUser);

    if (command.intent === "confirm") {
      if (!pendingCommand) {
        setStatus("error", command.replyToUser);
        return;
      }

      const commandToGenerate = pendingCommand;
      pendingCommand = null;
      setStatus("generating", "已确认，正在生成图片");
      void generateImageFromPrompt(commandToGenerate.prompt || commandToGenerate.subject);
      return;
    }

    if (command.intent === "reject") {
      pendingCommand = null;
      setStatus("ready", "请重新说出你想生成的画面");
      return;
    }

    pendingCommand = command;
    setStatus("ready", "请说“确认”开始生成，或说“不对 / 改成……”调整");
  } catch (error) {
    setStatus("error", error.message || "需求理解失败");
  }
}

function startBrowserSpeechRecognition() {
  if (isRecording || !SpeechRecognition) {
    return;
  }

  browserSpeechFinalText = "";
  browserSpeechError = "";
  speechRecognition = createSpeechRecognition();
  wantsRecording = true;
  usingBrowserSpeech = true;
  isRecording = true;
  micButton.classList.add("is-recording");
  setStatus("listening", "请开始说话，松开后完成识别");
  showTranscript("");

  try {
    speechRecognition.start();
  } catch (error) {
    usingBrowserSpeech = false;
    wantsRecording = false;
    isRecording = false;
    micButton.classList.remove("is-recording");
    setStatus("error", error.message || "浏览器语音识别不可用");
  }
}

function stopBrowserSpeechRecognition() {
  if (!usingBrowserSpeech || !speechRecognition) {
    return;
  }

  wantsRecording = false;
  setStatus("thinking", "正在整理识别结果");

  try {
    speechRecognition.stop();
  } catch {
    speechRecognition.abort();
  }
}

function getAudioMimeType() {
  const mimeTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];

  if (!window.MediaRecorder) {
    return "";
  }

  return mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

async function ensureMediaStream() {
  if (mediaStream) {
    return mediaStream;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("当前浏览器不支持录音");
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true
    }
  });

  return mediaStream;
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    startBrowserSpeechRecognition();
    return;
  }

  if (isRecording) {
    return;
  }

  wantsRecording = true;

  try {
    const stream = await ensureMediaStream();

    if (!wantsRecording) {
      return;
    }

    const mimeType = getAudioMimeType();
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", () => {
      void uploadRecording();
    }, { once: true });

    mediaRecorder.start();
    startPassiveSpeechFallback();
    isRecording = true;
    micButton.classList.add("is-recording");
    setStatus("listening", "请开始说话，松开后进行 ASR 转写和说话人分析");
    clearSpeechInsights();
    showTranscript("");
  } catch (error) {
    setStatus("error", error.message || "麦克风不可用");
  }
}

function stopRecording() {
  if (usingBrowserSpeech) {
    stopBrowserSpeechRecognition();
    return;
  }

  wantsRecording = false;

  if (!isRecording || !mediaRecorder) {
    return;
  }

  isRecording = false;
  micButton.classList.remove("is-recording");
  setStatus("thinking", "正在进行 ASR 转写和说话人分析");
  stopPassiveSpeechFallback();

  if (mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

async function uploadRecording() {
  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const audioBlob = new Blob(audioChunks, { type: mimeType });
  audioChunks = [];

  if (audioBlob.size === 0) {
    setStatus("error", "没有录到声音");
    return;
  }

  try {
    setStatus("thinking", "正在上传语音并分析说话人属性");
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": audioBlob.type || "audio/webm"
      },
      body: audioBlob
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "转写失败");
    }

    const transcript = payload.text || "";
    showSpeechInsights(payload);
    void handleRecognizedText(transcript);
  } catch (error) {
    await waitForPassiveSpeechFallback();
    const fallbackTranscript = getPassiveSpeechTranscript();

    if (fallbackTranscript) {
      clearSpeechInsights();
      setStatus("thinking", "ASR 服务不可用，已使用浏览器识别结果");
      void handleRecognizedText(fallbackTranscript);
      return;
    }

    clearSpeechInsights();
    setStatus("error", error.message || "语音转写失败");
  }
}

micButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  activePointerId = event.pointerId;
  micButton.setPointerCapture(activePointerId);
  void startRecording();
});

micButton.addEventListener("pointerup", (event) => {
  event.preventDefault();
  activePointerId = undefined;
  stopRecording();
});

micButton.addEventListener("pointercancel", () => {
  activePointerId = undefined;
  stopRecording();
});

micButton.addEventListener("lostpointercapture", () => {
  if (activePointerId !== undefined) {
    activePointerId = undefined;
    stopRecording();
  }
});

micButton.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

micButton.addEventListener("keydown", (event) => {
  if (event.repeat || (event.key !== " " && event.key !== "Enter")) {
    return;
  }

  event.preventDefault();
  void startRecording();
});

micButton.addEventListener("keyup", (event) => {
  if (event.key !== " " && event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  stopRecording();
});
