const micButton = document.querySelector("#mic-button");
const statusChip = document.querySelector("#status-chip");
const voiceTitle = document.querySelector("#voice-title");
const voiceStatus = document.querySelector("#voice-status");
const transcriptPreview = document.querySelector("#transcript-preview");
const versionList = document.querySelector("#version-list");

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
    message: "第 1 步只验证录音和转写"
  },
  error: {
    chip: "异常",
    title: "没有听清",
    message: "请再试一次"
  }
};

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
