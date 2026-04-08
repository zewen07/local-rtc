const state = {
  socket: null,
  socketReady: false,
  transportMode: "connecting",
  wsFailed: false,
  pollPresenceTimer: null,
  pollMessagesTimer: null,
  heartbeatTimer: null,
  self: null,
  devices: [],
  selectedTargetId: null,
  peerConnection: null,
  dataChannel: null,
  currentPeerId: null,
  pendingRequest: null,
  tasks: [],
  incomingFiles: new Map(),
};

const CHUNK_SIZE = 64 * 1024;
const STORAGE_PREFIX = "local-rtc-";
const WS_TIMEOUT_MS = 3500;
const POLL_PRESENCE_MS = 2000;
const POLL_MESSAGES_MS = 1000;
const HEARTBEAT_MS = 15000;

const elements = {
  socketStatus: document.getElementById("socketStatus"),
  deviceTypeBadge: document.getElementById("deviceTypeBadge"),
  deviceNameInput: document.getElementById("deviceNameInput"),
  deviceIdValue: document.getElementById("deviceIdValue"),
  capabilitySummary: document.getElementById("capabilitySummary"),
  onlineCount: document.getElementById("onlineCount"),
  devicesList: document.getElementById("devicesList"),
  peerStatus: document.getElementById("peerStatus"),
  selectedTargetName: document.getElementById("selectedTargetName"),
  selectedTargetHint: document.getElementById("selectedTargetHint"),
  clearTargetBtn: document.getElementById("clearTargetBtn"),
  textInput: document.getElementById("textInput"),
  sendTextBtn: document.getElementById("sendTextBtn"),
  pickFileBtn: document.getElementById("pickFileBtn"),
  pickFolderBtn: document.getElementById("pickFolderBtn"),
  fileInput: document.getElementById("fileInput"),
  folderInput: document.getElementById("folderInput"),
  taskList: document.getElementById("taskList"),
  taskCount: document.getElementById("taskCount"),
  toastMessage: document.getElementById("toastMessage"),
  incomingSheet: document.getElementById("incomingSheet"),
  incomingSummary: document.getElementById("incomingSummary"),
  closeSheetBtn: document.getElementById("closeSheetBtn"),
  rejectTransferBtn: document.getElementById("rejectTransferBtn"),
  acceptTransferBtn: document.getElementById("acceptTransferBtn"),
  deviceTemplate: document.getElementById("deviceTemplate"),
  taskTemplate: document.getElementById("taskTemplate"),
};

let toastTimer = null;

window.addEventListener("error", (event) => {
  surfaceFatalError(event.error?.message || event.message || "页面初始化失败");
});

boot();

function boot() {
  try {
    const capabilities = detectCapabilities();
    const deviceType = detectDeviceType();
    const savedName = safeStorageGet("device-name");
    const defaultName = savedName || buildDefaultDeviceName(deviceType);
    const deviceId = safeStorageGet("device-id") || createId();
    safeStorageSet("device-id", deviceId);

    state.self = { deviceId, deviceType, deviceName: defaultName, capabilities };
    elements.deviceNameInput.value = defaultName;
    elements.deviceIdValue.textContent = deviceId;
    elements.deviceTypeBadge.textContent = labelDeviceType(deviceType);
    elements.capabilitySummary.textContent = summarizeCapabilities(capabilities);

    if (!capabilities.directoryUpload) {
      elements.pickFolderBtn.textContent = "当前浏览器不支持文件夹";
    }

    bindEvents();
    syncActionButtons();
    connectSocket();
  } catch (error) {
    surfaceFatalError(error.message || "页面初始化失败");
  }
}

function bindEvents() {
  elements.deviceNameInput.addEventListener("change", async () => {
    const next = elements.deviceNameInput.value.trim() || buildDefaultDeviceName(state.self.deviceType);
    state.self.deviceName = next;
    safeStorageSet("device-name", next);
    await registerPresence();
  });

  elements.sendTextBtn.addEventListener("click", async () => {
    if (!ensureTargetSelected()) {
      return;
    }

    const text = elements.textInput.value.trim();
    if (!text) {
      addTask({ direction: "system", title: "发送文本", status: "请先输入要发送的内容。" });
      return;
    }

    try {
      await ensureReadyToSend({ kind: "text", kinds: ["text"], summary: text.length > 22 ? `${text.slice(0, 22)}...` : text });
      sendJsonMessage({ type: "text", transferId: createId(), text, sentAt: new Date().toISOString() });
      addTask({ direction: "outgoing", title: "文本已发送", status: "已写入点对点通道", meta: [`${text.length} 个字符`, targetLabel()], progress: 100 });
      elements.textInput.value = "";
    } catch (error) {
      addTask({ direction: "system", title: "发送文本失败", status: error.message });
    }
  });

  elements.pickFileBtn.addEventListener("click", () => {
    if (!ensureTargetSelected()) {
      return;
    }
    elements.fileInput.click();
  });

  elements.pickFolderBtn.addEventListener("click", () => {
    if (!ensureTargetSelected()) {
      return;
    }
    if (!state.self.capabilities.directoryUpload) {
      addTask({ direction: "system", title: "当前浏览器不支持", status: "该浏览器不支持文件夹上传，请改用文件发送。" });
      return;
    }
    elements.folderInput.click();
  });

  elements.fileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      await queueFileTransfer(files, "files");
      event.target.value = "";
    }
  });

  elements.folderInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      await queueFileTransfer(files, "folder");
      event.target.value = "";
    }
  });

  elements.clearTargetBtn.addEventListener("click", clearSelectedTarget);
  elements.closeSheetBtn.addEventListener("click", closeIncomingSheet);
  elements.rejectTransferBtn.addEventListener("click", () => respondTransferRequest(false));
  elements.acceptTransferBtn.addEventListener("click", () => respondTransferRequest(true));
}

function connectSocket() {
  let settled = false;
  updateSocketStatus("连接中");

  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}`);
    state.socket = socket;

    const timeoutId = window.setTimeout(() => {
      if (!settled) {
        state.wsFailed = true;
        socket.close();
        fallbackToPolling("WebSocket 连接超时，已切换为轮询模式");
      }
    }, WS_TIMEOUT_MS);

    socket.addEventListener("open", async () => {
      settled = true;
      window.clearTimeout(timeoutId);
      state.socketReady = true;
      state.transportMode = "ws";
      updateSocketStatus("在线 (WebSocket)");
      stopPolling();
      startHeartbeat();
      await registerPresence();
    });

    socket.addEventListener("close", () => {
      if (state.transportMode === "ws") {
        state.socketReady = false;
        updateSocketStatus("连接已断开，切换轮询中");
        fallbackToPolling("WebSocket 已断开，已切换为轮询模式");
      }
    });

    socket.addEventListener("error", () => {
      if (!settled) {
        state.wsFailed = true;
      }
    });

    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      await handleSignalMessage(message);
    });
  } catch (error) {
    fallbackToPolling(error.message || "WebSocket 初始化失败");
  }
}

async function fallbackToPolling(reason) {
  if (state.transportMode === "poll") {
    return;
  }

  state.socketReady = false;
  state.transportMode = "poll";
  updateSocketStatus("在线 (轮询)");
  stopPolling();
  startPolling();
  startHeartbeat();
  await registerPresence();
  addTask({ direction: "system", title: "已切换为轮询模式", status: reason });
}

function startPolling() {
  state.pollPresenceTimer = window.setInterval(() => {
    pollPresence().catch(() => {});
  }, POLL_PRESENCE_MS);
  state.pollMessagesTimer = window.setInterval(() => {
    pollMessages().catch(() => {});
  }, POLL_MESSAGES_MS);
  pollPresence().catch(() => {});
  pollMessages().catch(() => {});
}

function stopPolling() {
  if (state.pollPresenceTimer) window.clearInterval(state.pollPresenceTimer);
  if (state.pollMessagesTimer) window.clearInterval(state.pollMessagesTimer);
  state.pollPresenceTimer = null;
  state.pollMessagesTimer = null;
}

function startHeartbeat() {
  if (state.heartbeatTimer) {
    return;
  }
  state.heartbeatTimer = window.setInterval(() => {
    sendHeartbeat().catch(() => {});
  }, HEARTBEAT_MS);
}

async function registerPresence() {
  if (!state.self) {
    return;
  }

  if (state.transportMode === "ws" && state.socketReady) {
    sendSocket({ type: "register", ...state.self });
    return;
  }

  const result = await apiFetch("/api/client/register", {
    method: "POST",
    body: JSON.stringify(state.self),
  });
  if (result.device) {
    state.self.deviceId = result.device.deviceId;
    elements.deviceIdValue.textContent = result.device.deviceId;
  }
  if (Array.isArray(result.devices)) {
    state.devices = result.devices;
    renderDevices();
  }
}

async function pollPresence() {
  const result = await apiFetch(`/api/presence?deviceId=${encodeURIComponent(state.self.deviceId)}`);
  if (Array.isArray(result.devices)) {
    state.devices = result.devices;
    renderDevices();
  }
}

async function pollMessages() {
  const result = await apiFetch(`/api/messages/${encodeURIComponent(state.self.deviceId)}`);
  for (const message of result.messages || []) {
    await handleSignalMessage(message);
  }
}

async function sendHeartbeat() {
  if (state.transportMode === "ws" && state.socketReady) {
    sendSocket({ type: "heartbeat" });
    return;
  }
  await apiFetch("/api/client/heartbeat", {
    method: "POST",
    body: JSON.stringify({ deviceId: state.self.deviceId }),
  });
}

async function routeSignal(payload) {
  if (state.transportMode === "ws" && state.socketReady) {
    sendSocket(payload);
    return;
  }

  await apiFetch("/api/messages", {
    method: "POST",
    body: JSON.stringify({ ...payload, fromDeviceId: state.self.deviceId }),
  });
}

async function handleSignalMessage(message) {
  if (message.type === "registered" || message.type === "heartbeat:ack") {
    return;
  }

  if (message.type === "presence:update") {
    state.devices = (message.devices || []).filter((item) => item.deviceId !== state.self.deviceId);
    renderDevices();
    return;
  }

  if (message.type === "transfer:request") {
    state.pendingRequest = message;
    const kinds = message.payload?.kinds || [];
    const sender = deviceNameById(message.fromDeviceId);
    const kindText = kinds.length ? kinds.join(" + ") : "内容";
    const summary = message.payload?.summary ? ` 说明：${message.payload.summary}` : "";
    elements.incomingSummary.textContent = `${sender} 想向你发送${kindText}。${summary}`;
    elements.incomingSheet.classList.remove("hidden");
    return;
  }

  if (message.type === "transfer:response") {
    if (!message.accepted) {
      addTask({ direction: "system", title: "传输被拒绝", status: "对方没有接受本次请求。", meta: [targetLabel()] });
      return;
    }
    await beginOffer(message.fromDeviceId);
    return;
  }

  if (message.type === "signal:offer") {
    await acceptOffer(message);
    return;
  }

  if (message.type === "signal:answer") {
    if (state.peerConnection) {
      await state.peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
      updatePeerStatus("已连接，准备传输");
    }
    return;
  }

  if (message.type === "signal:ice") {
    if (state.peerConnection && message.candidate) {
      await state.peerConnection.addIceCandidate(message.candidate);
    }
    return;
  }

  if (message.type === "peer:left") {
    addTask({ direction: "system", title: "目标设备已离线", status: "请重新选择设备后再试。" });
    if (state.currentPeerId === message.targetId) closePeerConnection();
  }
}

async function respondTransferRequest(accepted) {
  if (!state.pendingRequest) return;
  const pending = state.pendingRequest;
  await routeSignal({ type: "transfer:response", targetId: pending.fromDeviceId, accepted });
  if (!accepted) {
    addTask({ direction: "system", title: "已拒绝传输", status: `${deviceNameById(pending.fromDeviceId)} 的请求已被拒绝。` });
  }
  closeIncomingSheet();
}

async function ensureReadyToSend(payload) {
  if (!state.selectedTargetId) throw new Error("请先选择目标设备。");
  if (state.currentPeerId === state.selectedTargetId && state.dataChannel && state.dataChannel.readyState === "open") return;
  await routeSignal({ type: "transfer:request", targetId: state.selectedTargetId, payload });
  updatePeerStatus("等待对方确认");
  await waitFor(() => state.currentPeerId === state.selectedTargetId && state.dataChannel && state.dataChannel.readyState === "open", 20000);
}

async function beginOffer(targetId) {
  closePeerConnection();
  state.currentPeerId = targetId;
  const peer = buildPeerConnection(targetId);
  const channel = peer.createDataChannel("transfer", { ordered: true });
  attachDataChannel(channel);
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await routeSignal({ type: "signal:offer", targetId, offer });
}

async function acceptOffer(message) {
  closePeerConnection();
  state.currentPeerId = message.fromDeviceId;
  const peer = buildPeerConnection(message.fromDeviceId);
  await peer.setRemoteDescription(new RTCSessionDescription(message.offer));
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await routeSignal({ type: "signal:answer", targetId: message.fromDeviceId, answer });
}

function buildPeerConnection(targetId) {
  if (!window.RTCPeerConnection) throw new Error("当前浏览器不支持 WebRTC。请尝试使用较新的 Chrome、Edge 或 Safari。");
  const peer = new RTCPeerConnection({ iceServers: [] });

  peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      routeSignal({ type: "signal:ice", targetId, candidate: event.candidate }).catch(() => {});
    }
  });

  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "connected") updatePeerStatus("点对点已连接");
    else if (["failed", "disconnected", "closed"].includes(peer.connectionState)) updatePeerStatus("连接已关闭");
  });

  peer.addEventListener("datachannel", (event) => attachDataChannel(event.channel));
  state.peerConnection = peer;
  return peer;
}

function attachDataChannel(channel) {
  state.dataChannel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = CHUNK_SIZE * 2;
  channel.addEventListener("open", () => updatePeerStatus("点对点已连接"));
  channel.addEventListener("close", () => updatePeerStatus("未连接"));
  channel.addEventListener("message", async (event) => {
    await handleDataChannelMessage(event.data);
  });
}

function sendSocket(payload) {
  if (!state.socketReady || !state.socket) throw new Error("信令服务当前不可用。");
  state.socket.send(JSON.stringify(payload));
}

function sendJsonMessage(payload) {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") throw new Error("点对点通道尚未就绪。");
  state.dataChannel.send(JSON.stringify(payload));
}

async function queueFileTransfer(files, sourceKind) {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const isFolder = sourceKind === "folder";
  const summary = isFolder ? `${files.length} 个文件，${formatBytes(totalBytes)}` : files.length === 1 ? files[0].name : `${files.length} 个文件，${formatBytes(totalBytes)}`;

  try {
    await ensureReadyToSend({ kind: isFolder ? "folder" : "files", kinds: [isFolder ? "folder" : "files"], summary, fileCount: files.length, totalBytes });
    const transferId = createId();
    const taskId = addTask({ direction: "outgoing", title: isFolder ? "发送文件夹" : "发送文件", status: "传输中", meta: [summary, targetLabel()], progress: 0 });
    let sentBytes = 0;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const relativePath = file.webkitRelativePath || file.name;
      sendJsonMessage({ type: "file-meta", transferId, fileId: createId(), name: file.name, relativePath, mime: file.type || "application/octet-stream", size: file.size, totalFiles: files.length, fileIndex: index + 1, rootName: isFolder ? relativePath.split("/")[0] : null });
      let offset = 0;
      while (offset < file.size) {
        const slice = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        await waitForBufferedAmount();
        state.dataChannel.send(slice);
        offset += slice.byteLength;
        sentBytes += slice.byteLength;
        updateTask(taskId, { progress: totalBytes ? Math.min(99, Math.round((sentBytes / totalBytes) * 100)) : 100, status: `发送中 ${formatBytes(sentBytes)} / ${formatBytes(totalBytes)}` });
      }
      sendJsonMessage({ type: "file-complete", transferId, relativePath });
    }

    sendJsonMessage({ type: "transfer-complete", transferId, totalBytes, totalFiles: files.length });
    updateTask(taskId, { progress: 100, status: "已发送，等待对方保存" });
  } catch (error) {
    addTask({ direction: "system", title: "文件传输失败", status: error.message });
  }
}

async function handleDataChannelMessage(data) {
  if (typeof data !== "string") {
    handleIncomingChunk(data);
    return;
  }

  const message = JSON.parse(data);
  if (message.type === "text") {
    addTask({ direction: "incoming", title: "收到文本", status: "已接收", content: message.text, meta: [peerLabel()], progress: 100 });
    return;
  }

  if (message.type === "file-meta") {
    const existing = state.incomingFiles.get(message.transferId) || { files: [], receivedBytes: 0, expectedBytes: 0, totalFiles: message.totalFiles, taskId: null, currentFile: null };
    existing.currentFile = { ...message, chunks: [], received: 0 };
    existing.expectedBytes += message.size;
    if (!existing.taskId) existing.taskId = addTask({ direction: "incoming", title: message.totalFiles > 1 ? "接收文件集" : "接收文件", status: "传输中", meta: [peerLabel()], progress: 0 });
    state.incomingFiles.set(message.transferId, existing);
    return;
  }

  if (message.type === "file-complete") return finalizeIncomingFile(message.transferId);
  if (message.type === "transfer-complete") return finalizeIncomingTransfer(message.transferId);
  if (message.type === "transfer-error") addTask({ direction: "system", title: "远端传输错误", status: message.message || "未知错误" });
}

function handleIncomingChunk(chunk) {
  const activeTransfer = Array.from(state.incomingFiles.values()).find((entry) => entry.currentFile);
  if (!activeTransfer || !activeTransfer.currentFile) return;
  activeTransfer.currentFile.chunks.push(chunk);
  activeTransfer.receivedBytes += chunk.byteLength;
  if (activeTransfer.taskId) {
    updateTask(activeTransfer.taskId, { progress: activeTransfer.expectedBytes ? Math.min(99, Math.round((activeTransfer.receivedBytes / activeTransfer.expectedBytes) * 100)) : 0, status: `接收中 ${formatBytes(activeTransfer.receivedBytes)} / ${formatBytes(activeTransfer.expectedBytes)}` });
  }
}

function finalizeIncomingFile(transferId) {
  const entry = state.incomingFiles.get(transferId);
  if (!entry || !entry.currentFile) return;
  const file = entry.currentFile;
  entry.files.push({ name: file.name, relativePath: file.relativePath, blob: new Blob(file.chunks, { type: file.mime }), size: file.size });
  entry.currentFile = null;
}

function finalizeIncomingTransfer(transferId) {
  const entry = state.incomingFiles.get(transferId);
  if (!entry) return;
  updateTask(entry.taskId, { progress: 100, status: "接收完成", actions: buildDownloadActions(entry.files), meta: [`${entry.files.length} 个文件`, `${formatBytes(entry.files.reduce((sum, file) => sum + file.size, 0))}`, peerLabel()] });
  state.incomingFiles.delete(transferId);
}

function buildDownloadActions(files) {
  return files.map((file) => ({ label: files.length === 1 ? "下载文件" : `下载 ${shorten(file.relativePath, 22)}`, onClick: () => downloadBlob(file.blob, file.relativePath) }));
}

function downloadBlob(blob, fileName) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = fileName.replace(/[\\/:*?"<>|]+/g, "_");
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function addTask(task) {
  const entry = { id: createId(), progress: 0, meta: [], actions: [], ...task, createdAt: new Date().toLocaleTimeString() };
  state.tasks.unshift(entry);
  renderTasks();
  return entry.id;
}

function updateTask(taskId, updates) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  Object.assign(task, updates);
  renderTasks();
}

function renderDevices() {
  elements.onlineCount.textContent = `${state.devices.length} 台`;
  if (!state.devices.length) {
    elements.devicesList.className = "devices-list empty-state";
    elements.devicesList.textContent = "暂无其他在线设备";
    renderSelectedTarget();
    return;
  }

  elements.devicesList.className = "devices-list";
  elements.devicesList.innerHTML = "";
  for (const device of state.devices) {
    const fragment = elements.deviceTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".device-card");
    fragment.querySelector(".device-card__name").textContent = device.deviceName;
    fragment.querySelector(".device-card__type").textContent = `${labelDeviceType(device.deviceType)}${device.transport === "poll" ? " · 轮询" : ""}`;
    fragment.querySelector(".device-card__caps").textContent = summarizeCapabilities(device.capabilities || {});
    if (device.deviceId === state.selectedTargetId) button.classList.add("is-selected");
    button.addEventListener("click", () => {
      if (state.selectedTargetId === device.deviceId) {
        clearSelectedTarget();
      } else {
        state.selectedTargetId = device.deviceId;
        syncActionButtons();
      }
      renderDevices();
    });
    elements.devicesList.appendChild(fragment);
  }
  renderSelectedTarget();
}

function renderSelectedTarget() {
  const target = state.devices.find((item) => item.deviceId === state.selectedTargetId);
  if (!target) {
    elements.selectedTargetName.textContent = "未选择";
    elements.selectedTargetHint.textContent = "先选择一台在线设备，再点一次可取消";
    elements.clearTargetBtn.classList.add("hidden");
    syncActionButtons();
    return;
  }
  elements.selectedTargetName.textContent = target.deviceName;
  elements.selectedTargetHint.textContent = `${labelDeviceType(target.deviceType)} · ${summarizeCapabilities(target.capabilities || {})} · 可点按钮或再点一次取消`;
  elements.clearTargetBtn.classList.remove("hidden");
  syncActionButtons();
}

function renderTasks() {
  elements.taskCount.textContent = `${state.tasks.length} 条`;
  if (!state.tasks.length) {
    elements.taskList.className = "task-list empty-state";
    elements.taskList.textContent = "还没有传输记录";
    return;
  }

  elements.taskList.className = "task-list";
  elements.taskList.innerHTML = "";
  for (const task of state.tasks) {
    const fragment = elements.taskTemplate.content.cloneNode(true);
    fragment.querySelector(".task-card__title").textContent = task.title;
    fragment.querySelector(".task-card__status").textContent = task.status;
    const content = fragment.querySelector(".task-card__content");
    if (task.content) {
      content.textContent = task.content;
      content.classList.remove("hidden");
    }
    fragment.querySelector(".task-card__meta").innerHTML = [task.direction === "incoming" ? "接收" : task.direction === "outgoing" ? "发送" : "系统", task.createdAt].concat(task.meta || []).map((item) => `<span>${escapeHtml(String(item))}</span>`).join("");
    fragment.querySelector(".progress-bar").style.width = `${task.progress || 0}%`;
    const actions = fragment.querySelector(".task-card__actions");
    for (const action of task.actions || []) {
      const button = document.createElement("button");
      button.className = "ghost-button";
      button.textContent = action.label;
      button.addEventListener("click", action.onClick);
      actions.appendChild(button);
    }
    elements.taskList.appendChild(fragment);
  }
}

function updateSocketStatus(text) {
  elements.socketStatus.textContent = text;
}

function updatePeerStatus(text) {
  elements.peerStatus.textContent = text;
}

function closeIncomingSheet() {
  state.pendingRequest = null;
  elements.incomingSheet.classList.add("hidden");
}

function closePeerConnection() {
  if (state.dataChannel) try { state.dataChannel.close(); } catch (_error) {}
  if (state.peerConnection) try { state.peerConnection.close(); } catch (_error) {}
  state.peerConnection = null;
  state.dataChannel = null;
  state.currentPeerId = null;
  updatePeerStatus("未连接");
}

function clearSelectedTarget() {
  if (state.currentPeerId === state.selectedTargetId) {
    closePeerConnection();
  }
  state.selectedTargetId = null;
  syncActionButtons();
  renderDevices();
  renderSelectedTarget();
}

function syncActionButtons() {
  const hasTarget = Boolean(state.selectedTargetId);
  elements.sendTextBtn.classList.toggle("is-disabled", !hasTarget);
  elements.pickFileBtn.classList.toggle("is-disabled", !hasTarget);
  elements.pickFolderBtn.classList.toggle("is-disabled", !hasTarget || !state.self?.capabilities?.directoryUpload);
}

function ensureTargetSelected() {
  if (state.selectedTargetId) {
    return true;
  }
  showToast("请先选择目标设备");
  return false;
}

function showToast(message) {
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  elements.toastMessage.textContent = message;
  elements.toastMessage.classList.remove("hidden");
  toastTimer = window.setTimeout(() => {
    elements.toastMessage.classList.add("hidden");
    elements.toastMessage.textContent = "";
    toastTimer = null;
  }, 3000);
}

async function waitForBufferedAmount() {
  if (!state.dataChannel) throw new Error("点对点通道已关闭。");
  if (state.dataChannel.bufferedAmount <= state.dataChannel.bufferedAmountLowThreshold) return;
  await new Promise((resolve) => {
    const handler = () => {
      state.dataChannel.removeEventListener("bufferedamountlow", handler);
      resolve();
    };
    state.dataChannel.addEventListener("bufferedamountlow", handler, { once: true });
  });
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待点对点连接超时。");
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json();
}

function detectCapabilities() {
  return {
    webrtc: Boolean(window.RTCPeerConnection),
    fileUpload: Boolean(window.File && window.FileReader),
    directoryUpload: "webkitdirectory" in document.createElement("input"),
    download: document.createElement("a").download !== undefined,
  };
}

function detectDeviceType() {
  const ua = navigator.userAgent.toLowerCase();
  if (/ipad|tablet/.test(ua)) return "tablet";
  if (/iphone|android|mobile/.test(ua)) return "mobile";
  return "desktop";
}

function buildDefaultDeviceName(deviceType) {
  const prefix = deviceType === "mobile" ? "手机" : deviceType === "tablet" ? "平板" : "桌面";
  return `${prefix}-${Math.random().toString(36).slice(2, 6)}`;
}

function summarizeCapabilities(capabilities) {
  const labels = [];
  if (capabilities.webrtc) labels.push("WebRTC");
  if (capabilities.fileUpload) labels.push("文件");
  if (capabilities.directoryUpload) labels.push("文件夹");
  return labels.join(" / ") || "基础";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function labelDeviceType(type) {
  if (type === "mobile") return "手机";
  if (type === "tablet") return "平板";
  return "桌面";
}

function deviceNameById(deviceId) {
  const target = state.devices.find((item) => item.deviceId === deviceId);
  return target ? target.deviceName : deviceId;
}

function targetLabel() {
  const target = state.devices.find((item) => item.deviceId === state.selectedTargetId);
  return target ? `目标 ${target.deviceName}` : "目标设备";
}

function peerLabel() {
  const target = state.devices.find((item) => item.deviceId === state.currentPeerId);
  return target ? `来自 ${target.deviceName}` : "来自当前会话";
}

function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function surfaceFatalError(message) {
  updateSocketStatus("启动失败");
  elements.deviceTypeBadge.textContent = "异常";
  elements.capabilitySummary.textContent = message;
  addTask({ direction: "system", title: "页面初始化失败", status: message });
}

function safeStorageGet(key) {
  try {
    return window.localStorage ? window.localStorage.getItem(STORAGE_PREFIX + key) : null;
  } catch (_error) {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    if (window.localStorage) window.localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch (_error) {}
}

function createId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch (_error) {}
  return `fallback-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
