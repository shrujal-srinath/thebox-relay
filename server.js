/**
 * THE BOX — Relay Server v1.0
 * Stateful WebSocket relay between ESP32 scoring device and browser clients.
 *
 * Architecture:
 *   ESP32  ──WSS──►  this relay  ◄──WSS──  browser (localhost or Vercel)
 *
 * Connection types:
 *   Device  → connects with ?role=device&id=XXXX
 *   Browser → connects with ?role=browser&id=XXXX
 *
 * The relay:
 *   - Holds last known game state per session in memory
 *   - Sends cached state immediately to any browser that joins mid-game
 *   - Strips the "pending" field before forwarding to browsers
 *   - Enforces seq numbers — drops stale messages
 *   - Never echoes a message back to its sender
 *   - Heartbeat every 20s to detect dead connections
 */

"use strict";

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_MESSAGE_BYTES = 4096; // 4KB — state messages are ~200 bytes, this is generous
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ─── In-memory session store ──────────────────────────────────────────────────
// Map<sessionId, Session>
// Session = {
//   device: WebSocket | null,
//   browsers: Set<WebSocket>,
//   lastState: object | null,   — last valid state message from device
//   lastSeq: number,            — highest seq seen for this session
// }
const sessions = new Map();

function getOrCreateSession(id) {
    if (!sessions.has(id)) {
        sessions.set(id, {
            device: null,
            browsers: new Set(),
            lastState: null,
            lastSeq: -1,
        });
    }
    return sessions.get(id);
}

function cleanupSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    // Only delete if both sides are gone
    if (!s.device && s.browsers.size === 0) {
        sessions.delete(id);
        console.log(`[session] ${id} removed (empty)`);
    }
}

// ─── Message helpers ──────────────────────────────────────────────────────────
function send(ws, obj) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(JSON.stringify(obj));
    } catch (e) {
        console.error("[send] error:", e.message);
    }
}

function broadcast(clients, obj, exclude = null) {
    const payload = JSON.stringify(obj);
    for (const client of clients) {
        if (client === exclude) continue;
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
            client.send(payload);
        } catch (e) {
            console.error("[broadcast] error:", e.message);
        }
    }
}

// Strip pending field — browsers never see pending scoring state
function stripPending(stateObj) {
    const clean = { ...stateObj };
    delete clean.pending;
    return clean;
}

// ─── HTTP server (Railway requires WS on top of HTTP) ────────────────────────
const httpServer = http.createServer((req, res) => {
    // Health check endpoint — used by Railway and monitoring
    if (req.url === "/health") {
        let devices = 0, browsers = 0;
        for (const [, s] of sessions) {
            if (s.device && s.device.readyState === 1) devices++;
            browsers += s.browsers.size;
        }
        const stats = {
            status: "ok",
            sessions: sessions.size,
            devices,
            browsers,
            uptime: Math.floor(process.uptime()),
            ts: Date.now(),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats));
        return;
    }
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("WebSocket connections only");
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
    // ── Parse query params ──────────────────────────────────────────────────────
    const url = new URL(req.url, `http://localhost`);
    const role = url.searchParams.get("role"); // "device" | "browser"
    const sessionId = url.searchParams.get("id"); // 4-char device code e.g. "A3K9"

    if (!role || !sessionId || !["device", "browser"].includes(role)) {
        ws.close(4000, "Missing or invalid role/id params");
        return;
    }

    // ── Origin check (only for browser connections) ───────────────────────────
    if (role === "browser" && ALLOWED_ORIGINS.length > 0) {
        const origin = req.headers.origin || "";
        const allowed =
            origin.includes("localhost") ||
            origin.includes("127.0.0.1") ||
            ALLOWED_ORIGINS.some((o) => origin.includes(o));
        if (!allowed) {
            console.warn(`[origin] rejected: ${origin}`);
            ws.close(4003, "Origin not allowed");
            return;
        }
    }

    const session = getOrCreateSession(sessionId);
    ws.role = role;
    ws.sessionId = sessionId;
    ws.isAlive = true;

    console.log(`[connect] ${role} joined session ${sessionId}`);

    // ── Device connection ──────────────────────────────────────────────────────
    if (role === "device") {
        // Only one device per session — close any existing
        if (session.device && session.device.readyState === WebSocket.OPEN) {
            console.warn(`[device] replacing existing device for session ${sessionId}`);
            session.device.close(4001, "Replaced by new device connection");
        }
        session.device = ws;

        // Tell device how many browsers are currently watching
        send(ws, {
            t: "relay_info",
            viewers: session.browsers.size,
            hasCache: session.lastState !== null,
        });
    }

    // ── Browser connection ─────────────────────────────────────────────────────
    if (role === "browser") {
        session.browsers.add(ws);

        // Immediately send cached state so scoreboard isn't blank on connect
        if (session.lastState) {
            send(ws, { ...stripPending(session.lastState), t: "state", cached: true });
            console.log(`[cache] sent to new browser in session ${sessionId}`);
        }

        // Tell browser the device connection status
        send(ws, {
            t: "relay_info",
            deviceConnected: session.device !== null && session.device.readyState === WebSocket.OPEN,
        });
    }

    // ── Message handler ────────────────────────────────────────────────────────
    ws.on("message", (raw) => {
        // Size guard
        if (raw.length > MAX_MESSAGE_BYTES) {
            console.warn(`[msg] oversized message from ${role} in session ${sessionId}, dropping`);
            return;
        }

        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            console.warn(`[msg] invalid JSON from ${role}, dropping`);
            return;
        }

        // ── Ping / pong ──────────────────────────────────────────────────────────
        if (msg.t === "ping") {
            send(ws, { t: "pong", ts: msg.ts ?? Date.now() });
            return;
        }

        // ── Hello (device reconnect) ─────────────────────────────────────────────
        if (msg.t === "hello" && role === "device") {
            // Device announces its last known seq on reconnect
            // If relay has a higher seq cached, send it back so device can reconcile
            if (session.lastState && session.lastState.seq > (msg.seq ?? -1)) {
                send(ws, { ...session.lastState, t: "state_reconcile" });
            }
            // Notify browsers device is back
            broadcast(session.browsers, { t: "relay_info", deviceConnected: true });
            return;
        }

        // ── State message (device → browsers) ────────────────────────────────────
        if (msg.t === "state" && role === "device") {
            const seq = typeof msg.seq === "number" ? msg.seq : -1;

            // Drop stale messages — seq must advance
            if (seq <= session.lastSeq) {
                console.log(`[seq] dropped stale seq ${seq} (last: ${session.lastSeq})`);
                return;
            }

            session.lastSeq = seq;
            session.lastState = msg; // cache with pending intact (device may need it)

            // Forward to all browsers — pending stripped
            const forBrowsers = stripPending(msg);
            broadcast(session.browsers, forBrowsers);
            return;
        }

        // ── Commands (browser → device) ──────────────────────────────────────────
        // Browsers can send commands back to the device (e.g. web control mode)
        if (msg.t === "cmd" && role === "browser") {
            if (session.device && session.device.readyState === WebSocket.OPEN) {
                send(session.device, { ...msg, src: "browser" });
            }
            return;
        }

        console.log(`[msg] unhandled type "${msg.t}" from ${role}`);
    });

    // ── Disconnect handler ────────────────────────────────────────────────────
    ws.on("close", (code, reason) => {
        console.log(`[disconnect] ${role} left session ${sessionId} (${code})`);

        if (role === "device") {
            session.device = null;
            // Notify all browsers device disconnected
            broadcast(session.browsers, { t: "relay_info", deviceConnected: false });
        }

        if (role === "browser") {
            session.browsers.delete(ws);
        }

        cleanupSession(sessionId);
    });

    ws.on("error", (err) => {
        console.error(`[error] ${role} in session ${sessionId}:`, err.message);
    });

    // ── Heartbeat pong response ───────────────────────────────────────────────
    ws.on("pong", () => {
        ws.isAlive = true;
    });
});

// ─── Heartbeat — detect and terminate dead connections ────────────────────────
// Railway and proxies can silently drop connections.
// Ping every 20s. If no pong received, terminate.
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            console.log(`[heartbeat] terminating dead ${ws.role} in session ${ws.sessionId}`);
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`[relay] The Box relay server running on port ${PORT}`);
    console.log(`[relay] Health check: http://localhost:${PORT}/health`);
    if (ALLOWED_ORIGINS.length > 0) {
        console.log(`[relay] Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
    } else {
        console.log(`[relay] ALLOWED_ORIGINS not set — accepting all browser origins`);
    }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
    console.log("[relay] SIGTERM received, shutting down gracefully");
    clearInterval(heartbeat);
    wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
    httpServer.close(() => {
        console.log("[relay] HTTP server closed");
        process.exit(0);
    });
});