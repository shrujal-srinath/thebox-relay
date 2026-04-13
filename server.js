/*
 * THE BOX — Relay Server v2.0
 * Deployed on Railway at thebox-relay-production.up.railway.app
 *
 * URL format:  wss://host/device/XXXX
 *   - Both ESP32 and browser connect to the SAME path
 *   - First connection to a room = stored as device or browser based on
 *     whether it sends a hello with t="hello" or just connects
 *   - All messages forwarded to every OTHER member of the room
 *   - /health returns session count, device count, browser count
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// sessions: Map<roomId, { device: WebSocket|null, browsers: Set<WebSocket> }>
const sessions = new Map();

function getOrCreateSession(roomId) {
    if (!sessions.has(roomId)) {
        sessions.set(roomId, { device: null, browsers: new Set() });
    }
    return sessions.get(roomId);
}

function cleanupSession(roomId) {
    const s = sessions.get(roomId);
    if (!s) return;
    if (!s.device && s.browsers.size === 0) {
        sessions.delete(roomId);
        console.log(`[${roomId}] Session cleaned up`);
    }
}

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        let devices = 0, browsers = 0;
        for (const [, s] of sessions) {
            if (s.device && s.device.readyState === WebSocket.OPEN) devices++;
            browsers += s.browsers.size;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            sessions: sessions.size,
            devices,
            browsers,
            uptime: Math.floor(process.uptime()),
            ts: Date.now(),
        }));
        return;
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('WebSocket connections only');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    // URL format: /device/XXXX  (4-char room code)
    const match = req.url?.match(/^\/device\/([A-Z0-9]{4})$/i);
    if (!match) {
        console.log(`[relay] Rejected bad path: ${req.url}`);
        ws.close(4001, 'Invalid path — use /device/XXXX');
        return;
    }

    const roomId = match[1].toUpperCase();
    const session = getOrCreateSession(roomId);

    // Determine role: first connection with no existing device = device
    // Any connection when device exists = browser
    // (ESP32 connects first, then browsers join)
    let role = 'browser';
    if (!session.device || session.device.readyState !== WebSocket.OPEN) {
        role = 'device';
        session.device = ws;
        console.log(`[${roomId}] Device connected`);
    } else {
        session.browsers.add(ws);
        console.log(`[${roomId}] Browser connected (${session.browsers.size} total)`);
    }

    ws.on('message', (data) => {
        const s = sessions.get(roomId);
        if (!s) return;

        try {
            const msg = JSON.parse(data.toString());

            // If ESP32 sends hello, confirm it as device role
            if (msg.t === 'hello' && role === 'browser') {
                // This is actually the device reconnecting — reassign
                role = 'device';
                s.browsers.delete(ws);
                s.device = ws;
                console.log(`[${roomId}] Device re-identified via hello`);
            }
        } catch (e) {
            // Not JSON — forward raw
        }

        if (role === 'device') {
            // Device → forward to ALL browsers
            for (const browser of s.browsers) {
                if (browser.readyState === WebSocket.OPEN) {
                    browser.send(data);
                }
            }
        } else {
            // Browser → forward to device
            if (s.device && s.device.readyState === WebSocket.OPEN) {
                s.device.send(data);
                console.log(`[${roomId}] Browser→Device: ${data.toString().slice(0, 80)}`);
            } else {
                console.log(`[${roomId}] Browser sent message but no device connected`);
            }
        }
    });

    ws.on('close', () => {
        const s = sessions.get(roomId);
        if (!s) return;

        if (role === 'device') {
            s.device = null;
            console.log(`[${roomId}] Device disconnected`);
        } else {
            s.browsers.delete(ws);
            console.log(`[${roomId}] Browser disconnected (${s.browsers.size} remaining)`);
        }
        cleanupSession(roomId);
    });

    ws.on('error', (err) => {
        console.log(`[${roomId}] WS error (${role}): ${err.message}`);
    });

    // Heartbeat ping every 25s to keep Railway proxy alive
    const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            clearInterval(ping);
        }
    }, 25000);
});

server.listen(PORT, () => {
    console.log(`[relay] THE BOX relay v2.0 on port ${PORT}`);
});