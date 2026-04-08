const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const WebSocket = require("ws");

const STALE_MS = 45_000;

function nowIso() {
  return new Date().toISOString();
}

function isPrivateIpv4(address) {
  return address.startsWith("192.168.") || address.startsWith("10.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function rankInterface(name, address) {
  const lowerName = name.toLowerCase();
  let score = 0;

  if (address.startsWith("192.168.")) score += 40;
  else if (address.startsWith("10.")) score += 35;
  else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) score += 25;

  if (/(wi-?fi|wlan|wireless)/.test(lowerName)) score += 30;
  if (/(ethernet|lan)/.test(lowerName)) score += 22;
  if (/(docker|wsl|hyper-v|vmware|virtualbox|vbox|tailscale|zerotier|vpn|loopback|bluetooth)/.test(lowerName)) score -= 50;

  return score;
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) {
        continue;
      }

      addresses.push({
        name,
        address: entry.address,
        score: rankInterface(name, entry.address),
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const item of addresses.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))) {
    if (!seen.has(item.address)) {
      seen.add(item.address);
      deduped.push(item);
    }
  }

  return deduped;
}

function createServer(options = {}) {
  const publicDir = options.publicDir || path.join(__dirname, "public");
  const app = express();
  const clients = new Map();
  const messageQueues = new Map();

  function ensureQueue(deviceId) {
    if (!messageQueues.has(deviceId)) {
      messageQueues.set(deviceId, []);
    }
    return messageQueues.get(deviceId);
  }

  function pruneClients() {
    const cutoff = Date.now() - STALE_MS;
    let changed = false;

    for (const [deviceId, client] of clients.entries()) {
      if (new Date(client.lastSeenAt).getTime() < cutoff) {
        clients.delete(deviceId);
        messageQueues.delete(deviceId);
        changed = true;
      }
    }

    return changed;
  }

  function deviceSummary(client) {
    return {
      deviceId: client.deviceId,
      deviceName: client.deviceName,
      deviceType: client.deviceType,
      capabilities: client.capabilities,
      joinedAt: client.joinedAt,
      lastSeenAt: client.lastSeenAt,
      transport: client.transport,
    };
  }

  function listDevices() {
    pruneClients();
    return Array.from(clients.values()).map(deviceSummary);
  }

  function sendJson(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function upsertClient(payload, ws, transport) {
    const deviceId = payload.deviceId || crypto.randomUUID();
    const existing = clients.get(deviceId);
    const joinedAt = existing ? existing.joinedAt : nowIso();
    const client = {
      deviceId,
      deviceName: payload.deviceName || "Unnamed device",
      deviceType: payload.deviceType || "desktop",
      capabilities: payload.capabilities || {},
      joinedAt,
      lastSeenAt: nowIso(),
      transport,
      ws: transport === "ws" ? ws : existing?.ws || null,
    };

    clients.set(deviceId, client);
    ensureQueue(deviceId);
    return client;
  }

  function broadcastPresence() {
    const payload = { type: "presence:update", devices: listDevices() };
    for (const client of clients.values()) {
      if (client.transport === "ws") {
        sendJson(client.ws, payload);
      }
    }
  }

  function notifyMissingPeer(requesterId, targetId) {
    const requester = clients.get(requesterId);
    if (!requester) {
      return;
    }

    const payload = { type: "peer:left", targetId };
    if (requester.transport === "ws") {
      sendJson(requester.ws, payload);
    } else {
      ensureQueue(requesterId).push(payload);
    }
  }

  function deliverToTarget(targetId, payload, requesterId) {
    pruneClients();
    const target = clients.get(targetId);
    if (!target) {
      notifyMissingPeer(requesterId, targetId);
      return false;
    }

    if (target.transport === "ws") {
      sendJson(target.ws, payload);
    } else {
      ensureQueue(targetId).push(payload);
    }
    return true;
  }

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      connectedClients: listDevices().length,
      timestamp: nowIso(),
    });
  });

  app.get("/api/presence", (req, res) => {
    const requesterId = req.query.deviceId;
    const devices = listDevices().filter((item) => item.deviceId !== requesterId);
    res.json({ ok: true, devices, ts: nowIso() });
  });

  app.post("/api/client/register", (req, res) => {
    const client = upsertClient(req.body || {}, null, "poll");
    broadcastPresence();
    res.json({
      ok: true,
      device: deviceSummary(client),
      devices: listDevices().filter((item) => item.deviceId !== client.deviceId),
    });
  });

  app.post("/api/client/heartbeat", (req, res) => {
    const { deviceId } = req.body || {};
    const client = deviceId ? clients.get(deviceId) : null;
    if (client) {
      client.lastSeenAt = nowIso();
    }
    res.json({ ok: true, ts: nowIso() });
  });

  app.get("/api/messages/:deviceId", (req, res) => {
    const { deviceId } = req.params;
    const client = clients.get(deviceId);
    if (client) {
      client.lastSeenAt = nowIso();
    }
    const queue = ensureQueue(deviceId);
    const messages = queue.splice(0, queue.length);
    res.json({ ok: true, messages, ts: nowIso() });
  });

  app.post("/api/messages", (req, res) => {
    const body = req.body || {};
    const fromDeviceId = body.fromDeviceId;
    const targetId = body.targetId;
    const type = body.type;

    if (!fromDeviceId || !targetId || !type) {
      res.status(400).json({ ok: false, message: "Missing message routing fields." });
      return;
    }

    const delivered = deliverToTarget(targetId, { ...body, fromDeviceId }, fromDeviceId);
    res.json({ ok: delivered });
  });

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  wss.on("error", () => {
    // Prevent unhandled WebSocketServer error events from masking server.listen errors.
  });

  wss.on("connection", (ws) => {
    let currentDeviceId = null;

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch (_error) {
        sendJson(ws, { type: "error", message: "Invalid JSON payload." });
        return;
      }

      const { type } = message;

      if (type === "register") {
        const client = upsertClient(message, ws, "ws");
        currentDeviceId = client.deviceId;
        sendJson(ws, { type: "registered", device: deviceSummary(client) });
        broadcastPresence();
        return;
      }

      if (!currentDeviceId || !clients.has(currentDeviceId)) {
        sendJson(ws, { type: "error", message: "Please register first." });
        return;
      }

      const client = clients.get(currentDeviceId);
      client.lastSeenAt = nowIso();

      if (["transfer:request", "transfer:response", "signal:offer", "signal:answer", "signal:ice"].includes(type)) {
        deliverToTarget(message.targetId, { ...message, fromDeviceId: currentDeviceId }, currentDeviceId);
        return;
      }

      if (type === "heartbeat") {
        sendJson(ws, { type: "heartbeat:ack", ts: Date.now() });
      }
    });

    function removeWsClient() {
      if (!currentDeviceId || !clients.has(currentDeviceId)) {
        return;
      }

      const client = clients.get(currentDeviceId);
      if (client.transport === "ws") {
        clients.delete(currentDeviceId);
        messageQueues.delete(currentDeviceId);
        broadcastPresence();
      }
    }

    ws.on("close", removeWsClient);
    ws.on("error", removeWsClient);
  });

  return {
    app,
    server,
    wss,
    getClientCount: () => listDevices().length,
  };
}

function startServer(options = {}) {
  const host = options.host || "0.0.0.0";
  const port = Number(options.port || 3000);
  const instance = createServer(options);

  return new Promise((resolve, reject) => {
    function onError(error) {
      instance.server.off("listening", onListening);
      reject(error);
    }

    function onListening() {
      instance.server.off("error", onError);
      resolve({
        ...instance,
        host,
        port,
      });
    }

    instance.server.once("error", onError);
    instance.server.once("listening", onListening);
    instance.server.listen(port, host);
  });
}

module.exports = {
  createServer,
  startServer,
  getLanAddresses,
};

if (require.main === module) {
  startServer({
    host: process.env.HOST || "0.0.0.0",
    port: process.env.PORT || 3000,
  })
    .then(({ host, port }) => {
      console.log(`Local RTC server listening on http://${host}:${port}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
