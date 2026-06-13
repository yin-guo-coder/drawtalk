const micButton = document.querySelector("#mic-button");
const statusChip = document.querySelector("#status-chip");
const voiceTitle = document.querySelector("#voice-title");
const voiceStatus = document.querySelector("#voice-status");
const transcriptPreview = document.querySelector("#transcript-preview");
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
    detail.textContent = version.prompt || "等待生成";

    item.append(title, detail);
    versionList.append(item);
  }
}

setStatus("idle");
showTranscript("");
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
      showTranscript(transcript);
      setStatus("ready", "浏览器已识别语音");
      return;
    }

    setStatus("error", browserSpeechError || "没有识别到文字");
  });

  return recognition;
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
  if (SpeechRecognition) {
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
    isRecording = true;
    micButton.classList.add("is-recording");
    setStatus("listening");
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
  setStatus("thinking");

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
    showTranscript(transcript);
    setStatus("ready", transcript ? "语音已转成文字" : "没有识别到文字");
  } catch (error) {
    setStatus("error", error.message || "转写失败");
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
