const micButton = document.querySelector("#mic-button");
const statusChip = document.querySelector("#status-chip");
const voiceTitle = document.querySelector("#voice-title");
const voiceStatus = document.querySelector("#voice-status");
const imageFrame = document.querySelector("#image-frame");
const emptyImage = document.querySelector(".empty-image");
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
let latestSpeakerProfile = {};
let currentVersionId;
let availableSpeechVoices = [];
let activeAssistantUtterance;
let speechRestartTimer;
let speechPlaybackToken = 0;

const assistantVoicePacks = {
  child: {
    male: {
      voiceNames: ["yunxi", "xiaoyi", "xiaoxiao", "yunyang", "kangkang"],
      rate: 1.08,
      pitch: 1.26
    },
    female: {
      voiceNames: ["xiaoxiao", "xiaoyi", "xiaobei", "huihui", "yaoyao"],
      rate: 1.1,
      pitch: 1.32
    },
    unknown: {
      voiceNames: ["xiaoxiao", "xiaoyi", "yunxi", "xiaobei"],
      rate: 1.08,
      pitch: 1.28
    }
  },
  teen: {
    male: {
      voiceNames: ["yunxi", "yunyang", "kangkang", "yunhao"],
      rate: 1.04,
      pitch: 1.12
    },
    female: {
      voiceNames: ["xiaoxiao", "xiaoyi", "xiaobei", "huihui"],
      rate: 1.05,
      pitch: 1.18
    },
    unknown: {
      voiceNames: ["xiaoxiao", "yunxi", "xiaoyi"],
      rate: 1.04,
      pitch: 1.12
    }
  },
  young: {
    male: {
      voiceNames: ["yunxi", "yunyang", "yunhao", "kangkang"],
      rate: 1,
      pitch: 0.98
    },
    female: {
      voiceNames: ["xiaoxiao", "xiaoyi", "huihui", "xiaobei"],
      rate: 1,
      pitch: 1.08
    },
    unknown: {
      voiceNames: ["xiaoxiao", "yunxi", "xiaoyi"],
      rate: 1,
      pitch: 1.02
    }
  },
  middle: {
    male: {
      voiceNames: ["yunyang", "yunhao", "yunxi", "kangkang"],
      rate: 0.94,
      pitch: 0.88
    },
    female: {
      voiceNames: ["xiaoxiao", "huihui", "xiaoyi", "xiaobei"],
      rate: 0.95,
      pitch: 1
    },
    unknown: {
      voiceNames: ["yunyang", "xiaoxiao", "yunxi"],
      rate: 0.95,
      pitch: 0.96
    }
  },
  senior: {
    male: {
      voiceNames: ["yunyang", "yunhao", "yunxi", "kangkang"],
      rate: 0.86,
      pitch: 0.78
    },
    female: {
      voiceNames: ["huihui", "xiaoxiao", "xiaoyi", "xiaobei"],
      rate: 0.88,
      pitch: 0.92
    },
    unknown: {
      voiceNames: ["yunyang", "huihui", "xiaoxiao"],
      rate: 0.88,
      pitch: 0.86
    }
  },
  unknown: {
    unknown: {
      voiceNames: ["xiaoxiao", "yunxi", "xiaoyi", "yunyang"],
      rate: 0.98,
      pitch: 1
    }
  }
};

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

function refreshSpeechVoices() {
  availableSpeechVoices = window.speechSynthesis?.getVoices?.() || [];
}

function normalizeVoiceField(value) {
  return String(value || "").trim().toLowerCase();
}

function clampSpeechValue(value, fallback, min, max) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(Math.max(numericValue, min), max);
}

function isChineseSpeechVoice(voice) {
  const lang = normalizeVoiceField(voice.lang);
  const name = normalizeVoiceField(voice.name);

  return (
    lang.startsWith("zh") ||
    name.includes("chinese") ||
    name.includes("mandarin") ||
    name.includes("\u4e2d\u6587") ||
    name.includes("\u666e\u901a\u8bdd")
  );
}

function getVoiceAgeGroup(speaker = {}) {
  const ageText = normalizeVoiceField(speaker.age);
  const combinedText = `${ageText} ${normalizeVoiceField(speaker.gender)}`;

  if (/child|kid|children|儿童|小孩/u.test(combinedText)) {
    return "child";
  }

  if (/teen|adolescent|少年|青少年/u.test(ageText)) {
    return "teen";
  }

  if (/middle|中年/u.test(ageText)) {
    return "middle";
  }

  if (/senior|elder|old|老年/u.test(ageText)) {
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

function getVoiceGenderGroup(speaker = {}) {
  const genderText = normalizeVoiceField(speaker.gender);

  if (/female|woman|girl|女性|女生|女/u.test(genderText)) {
    return "female";
  }

  if (/(^|[^a-z])male([^a-z]|$)|man|boy|男性|男生|男/u.test(genderText)) {
    return "male";
  }

  return "unknown";
}

function getAssistantVoicePack(speaker = {}) {
  const ageGroup = getVoiceAgeGroup(speaker);
  const genderGroup = getVoiceGenderGroup(speaker);
  const agePacks = assistantVoicePacks[ageGroup] || assistantVoicePacks.unknown;

  return agePacks[genderGroup] || agePacks.unknown || assistantVoicePacks.unknown.unknown;
}

function chooseSpeechVoice(voicePack = {}) {
  refreshSpeechVoices();

  const voices = availableSpeechVoices;
  const chineseVoices = voices.filter(isChineseSpeechVoice);
  const preferredNames = voicePack.voiceNames || [];

  for (const preferredName of preferredNames) {
    const normalizedPreferredName = normalizeVoiceField(preferredName);
    const voice = chineseVoices.find((candidate) => normalizeVoiceField(candidate.name).includes(normalizedPreferredName));

    if (voice) {
      return voice;
    }
  }

  return chineseVoices.find((voice) => voice.default) || chineseVoices[0];
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
  transcriptPreview.textContent = trimmed ? `“${trimmed}”` : "暂无语音文本";
  transcriptPreview.classList.toggle("is-empty", !trimmed);
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

function getSpeakerProfile(payload = {}) {
  const speaker = payload.speaker || {};

  return {
    gender: payload.gender || speaker.gender || "",
    age: payload.age || speaker.age || "",
    emotion: payload.emotion || speaker.emotion || ""
  };
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
  transcriptPreview.textContent = content || "暂无语音文本";
  transcriptPreview.classList.toggle("is-empty", !content);

  if (assistantText) {
    speakAssistantReply(assistantText);
  }
}

function buildAssistantUtterance(text, voicePack, voice, token, retryWithoutVoice) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = clampSpeechValue(voicePack.rate, 1, 0.75, 1.25);
  utterance.pitch = clampSpeechValue(voicePack.pitch, 1, 0.7, 1.4);
  utterance.volume = 1;

  if (voice && !retryWithoutVoice) {
    utterance.voice = voice;
    utterance.lang = voice.lang || "zh-CN";
  }

  utterance.onend = () => {
    if (speechPlaybackToken === token && activeAssistantUtterance === utterance) {
      activeAssistantUtterance = undefined;
    }
  };

  utterance.onerror = () => {
    if (speechPlaybackToken !== token) {
      return;
    }

    if (voice && !retryWithoutVoice) {
      window.setTimeout(() => speakAssistantReply(text, { retryWithoutVoice: true }), 80);
      return;
    }

    if (activeAssistantUtterance === utterance) {
      activeAssistantUtterance = undefined;
    }
  };

  return utterance;
}

function speakAssistantReply(text, options = {}) {
  const speechText = String(text || "").trim();

  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    return;
  }

  if (!speechText) {
    return;
  }

  window.clearTimeout(speechRestartTimer);
  const token = (speechPlaybackToken += 1);
  const voicePack = getAssistantVoicePack(latestSpeakerProfile);
  const voice = options.retryWithoutVoice ? undefined : chooseSpeechVoice(voicePack);

  window.speechSynthesis.cancel();

  speechRestartTimer = window.setTimeout(() => {
    if (speechPlaybackToken !== token) {
      return;
    }

    const utterance = buildAssistantUtterance(speechText, voicePack, voice, token, Boolean(options.retryWithoutVoice));
    activeAssistantUtterance = utterance;

    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }

    window.speechSynthesis.speak(utterance);
  }, 80);
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
  currentVersionId = Number(version.id);
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

    if (Number(version.id) === Number(currentVersionId)) {
      item.classList.add("is-current");
    }

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

async function loadVersions() {
  try {
    const response = await fetch("/api/versions");
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "版本列表加载失败");
    }

    versions = Array.isArray(payload.versions) ? payload.versions : [];

    if (versions[0]) {
      showGeneratedImage(versions[0]);
    }

    renderVersions(versions);
  } catch (error) {
    setStatus("error", error.message || "版本列表加载失败");
  }
}

setStatus("idle");
showTranscript("");
clearSpeechInsights();
renderVersions();
refreshSpeechVoices();

if (window.speechSynthesis?.addEventListener) {
  window.speechSynthesis.addEventListener("voiceschanged", refreshSpeechVoices);
}

void loadVersions();

window.drawtalkUi = {
  setStatus,
  showTranscript,
  speakAssistantReply,
  getAssistantVoicePack,
  chooseSpeechVoice,
  loadVersions,
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

async function parseVoiceCommand(text, speakerProfile = latestSpeakerProfile) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      previousCommand: pendingCommand,
      speaker: speakerProfile
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "需求理解失败");
  }

  return payload.command;
}

function includesAnyText(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function shouldAnalyzeSpeakerForCommand(command, text) {
  const normalizedText = String(text || "").trim();

  if (command.intent !== "generate" || command.userRevision) {
    return false;
  }

  if (includesAnyText(normalizedText, [
    "确认",
    "可以",
    "不对",
    "不是",
    "改",
    "换",
    "调整",
    "修改",
    "删除",
    "去掉",
    "不要",
    "保留",
    "回到",
    "返回",
    "继续",
    "基于"
  ])) {
    return false;
  }

  return includesAnyText(normalizedText, [
    "画",
    "生成",
    "绘制",
    "做一张",
    "来一张",
    "设计",
    "帮我"
  ]);
}

async function analyzeSpeakerFromRecording(audioBlob) {
  if (!audioBlob) {
    return {};
  }

  const response = await fetch("/api/analyze-speaker", {
    method: "POST",
    headers: {
      "Content-Type": audioBlob.type || "audio/webm"
    },
    body: audioBlob
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "说话人分析失败");
  }

  latestSpeakerProfile = getSpeakerProfile(payload);
  showSpeechInsights(payload);
  return latestSpeakerProfile;
}

function buildPendingCommandFromVersion(version) {
  const fallbackPrompt = version.prompt || version.systemUnderstanding || version.userSpeechText || "";

  return {
    intent: "generate",
    subject: version.systemUnderstanding || version.userSpeechText || fallbackPrompt,
    style: "",
    aspectRatio: version.params?.aspectRatio || "",
    mustKeep: [],
    mustAvoid: [],
    needConfirmation: true,
    prompt: fallbackPrompt,
    baseVersionId: version.id
  };
}

async function restoreVersion(command, userText) {
  const response = await fetch("/api/versions/restore", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      target: command.versionTarget,
      targetVersionId: command.targetVersionId,
      currentVersionId
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "版本回退失败");
  }

  const version = payload.version;
  versions = Array.isArray(payload.versions) ? payload.versions : versions;
  showGeneratedImage(version);
  renderVersions(versions);

  if (command.intent === "continue_from_version") {
    pendingCommand = buildPendingCommandFromVersion(version);
    showDialogue(userText, `已切到版本 ${version.id}，可以继续说要怎么修改。`);
    setStatus("ready", `可以继续修改版本 ${version.id}`);
    return;
  }

  pendingCommand = null;
  showDialogue(userText, `已回到版本 ${version.id}。`);
  setStatus("ready", `已回到版本 ${version.id}`);
}

async function handleRecognizedText(transcript, { audioBlob, speakerProfile = latestSpeakerProfile } = {}) {
  const trimmedTranscript = transcript.trim();

  if (!trimmedTranscript) {
    setStatus("error", "没有识别到文字");
    return;
  }

  showDialogue(trimmedTranscript, "");
  setStatus("thinking", "正在理解你的需求");

  try {
    let command = await parseVoiceCommand(trimmedTranscript, speakerProfile);

    if (shouldAnalyzeSpeakerForCommand(command, trimmedTranscript)) {
      try {
        setStatus("thinking", "正在根据绘图需求分析说话人特征");
        const analyzedSpeakerProfile = await analyzeSpeakerFromRecording(audioBlob);
        command = await parseVoiceCommand(trimmedTranscript, analyzedSpeakerProfile);
      } catch {
        latestSpeakerProfile = {};
        clearSpeechInsights();
      }
    }

    if (command.intent === "restore_version" || command.intent === "continue_from_version") {
      await restoreVersion(command, trimmedTranscript);
      return;
    }

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
    latestSpeakerProfile = {};
    clearSpeechInsights();
    setStatus("thinking", "正在上传语音并转写");
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
    void handleRecognizedText(transcript, { audioBlob, speakerProfile: latestSpeakerProfile });
  } catch (error) {
    await waitForPassiveSpeechFallback();
    const fallbackTranscript = getPassiveSpeechTranscript();

    if (fallbackTranscript) {
      latestSpeakerProfile = {};
      clearSpeechInsights();
      setStatus("thinking", "ASR 服务不可用，已使用浏览器识别结果");
      void handleRecognizedText(fallbackTranscript);
      return;
    }

    latestSpeakerProfile = {};
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
