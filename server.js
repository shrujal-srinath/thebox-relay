/*
 * THE BOX — Relay Server v3.0
 * thebox-relay-production.up.railway.app
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// sessions: Map<roomId, { device: WebSocket|null, browsers: Set<WebSocket> }>
const sessions = new Map();

function getOrCreateSession(roomId) {
    if (!sessions.has(roomId)) {
        sessions.set(roomId, { device: null, browsers: new Set(), lastState: null, lastSeq: -1 });
    }
    return sessions.get(roomId);
}

function cleanupSession(roomId) {
    const s = sessions.get(roomId);
    if (!s) return;
    if (!s.device && s.browsers.size === 0) {
        sessions.delete(roomId);
        console.log(`[${roomId}] Session removed`);
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

const wss = new WebSocket.Server({ 
    server,
    handleProtocols: (protocols, req) => {
        return protocols.size ? protocols.values().next().value : false;
    }
});

wss.on('connection', (ws, req) => {
    const url = req.url || '';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[relay] Incoming: "${url}" from ${ip}`);

    // Accept BOTH path formats:
    //   /device/XXXX          — new format (ESP32 v35+, website v2)
    //   /?role=device&id=XXXX — old format (backwards compat)
    //   /?role=browser&id=XXXX
    let roomId = null;
    let declaredRole = null;

    // Try new format first: /device/XXXX
    const newMatch = url.match(/\/device\/([A-Z0-9]{3,6})/i);
    if (newMatch) {
        roomId = newMatch[1].toUpperCase();
        declaredRole = 'device';
    }

    // Try old format: ?role=xxx&id=XXXX or ?id=XXXX&role=xxx
    if (!roomId) {
        const idMatch = url.match(/[?&]id=([A-Z0-9]{3,6})/i);
        const roleMatch = url.match(/[?&]role=(device|browser)/i);
        if (idMatch) {
            roomId = idMatch[1].toUpperCase();
            if (roleMatch) declaredRole = roleMatch[1].toLowerCase();
        }
    }

    if (!roomId) {
        console.log(`[relay] Rejected — no room ID in: "${url}" from ${ip}`);
        ws.close(4001, 'No room ID found in URL');
        return;
    }

    const session = getOrCreateSession(roomId);

    // Determine role
    let role;
    if (declaredRole === 'device') {
        role = 'device';
    } else if (declaredRole === 'browser') {
        role = 'browser';
    } else if (!session.device || session.device.readyState !== WebSocket.OPEN) {
        role = 'device';
    } else {
        role = 'browser';
    }

    if (role === 'device') {
        session.device = ws;
        console.log(`[${roomId}] Device connected (ip: ${ip})`);
    } else {
        session.browsers.add(ws);
        console.log(`[${roomId}] Browser connected (${session.browsers.size} total)`);
        if (session.lastState) {
            try {
                const cached = JSON.parse(session.lastState);
                cached.cached = true;
                ws.send(JSON.stringify(cached));
            } catch(e) {
                ws.send(session.lastState);
            }
        }
    }

    ws.on('message', (data) => {
        const s = sessions.get(roomId);
        if (!s) return;

        let msgStr = data.toString();

        try {
            const msg = JSON.parse(msgStr);
            
            if (msg.t === 'ping') {
                ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
                return;
            }

            if (msg.t === 'hello') {
                if (role === 'browser') {
                    role = 'device';
                    s.browsers.delete(ws);
                    s.device = ws;
                    console.log(`[${roomId}] Re-identified as device via hello`);
                }
                return;
            }

            if (role === 'device' && msg.t === 'state') {
                if (typeof msg.seq === 'number') {
                    if (msg.seq <= s.lastSeq) {
                        return; // drop stale sequence
                    }
                    s.lastSeq = msg.seq;
                }

                if (msg.pending !== undefined) {
                    delete msg.pending;
                }
                
                msgStr = JSON.stringify(msg);
                s.lastState = msgStr;
            }
        } catch (e) { /* not JSON */ }

        if (role === 'device') {
            let count = 0;
            for (const browser of s.browsers) {
                if (browser.readyState === WebSocket.OPEN) {
                    browser.send(msgStr);
                    count++;
                }
            }
            if (count > 0) console.log(`[${roomId}] Device→${count} browser(s)`);
        } else {
            if (s.device && s.device.readyState === WebSocket.OPEN) {
                s.device.send(msgStr);
            }
        }
    });

    ws.on('close', (code, reason) => {
        const s = sessions.get(roomId);
        if (!s) return;
        if (role === 'device') {
            s.device = null;
            console.log(`[${roomId}] Device disconnected (code:${code})`);
        } else {
            s.browsers.delete(ws);
            console.log(`[${roomId}] Browser disconnected (${s.browsers.size} remaining)`);
        }
        cleanupSession(roomId);
    });

    ws.on('unexpected-response', (req, res) => {
        console.log(`[${roomId}] HTTP Error during handshake: ${res.statusCode}`);
    });

    ws.on('error', (err) => {
        console.log(`[${roomId}] Error (${role}): ${err.message}`);
    });

    // Ping every 20s to keep Railway proxy alive
    const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            clearInterval(ping);
        }
    }, 20000);

    ws.on('close', () => clearInterval(ping));
});

server.listen(PORT, () => {
    console.log(`[relay] THE BOX relay v3.0 listening on port ${PORT}`);
});