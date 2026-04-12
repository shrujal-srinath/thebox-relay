/**
 * THE BOX — Relay test script
 * Run this locally alongside the server to verify everything works.
 *
 * Usage:
 *   Terminal 1: node server.js
 *   Terminal 2: node test.js
 *
 * What it tests:
 *   1. Device connects, sends a state message
 *   2. Browser connects, receives cached state immediately
 *   3. Device sends another state update, browser receives it
 *   4. Stale seq is dropped
 *   5. Pending field is stripped from browser messages
 *   6. Ping/pong works
 */

"use strict";

const WebSocket = require("ws");

const BASE = "ws://localhost:3000";
const SESSION = "TEST";
let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.error(`  ✗ ${label}`);
        failed++;
    }
}

function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function runTests() {
    console.log("\n[test] The Box relay test suite\n");

    // ── Test 1: Device connects ───────────────────────────────────────────────
    console.log("Test 1: Device connection");
    const device = new WebSocket(`${BASE}?role=device&id=${SESSION}`);
    await new Promise((r) => device.on("open", r));
    assert(device.readyState === WebSocket.OPEN, "device connected");

    // ── Test 2: Device sends state, relay accepts it ──────────────────────────
    console.log("\nTest 2: Device sends state");
    const state1 = {
        t: "state",
        seq: 1,
        src: "device-TEST",
        game: "g-test",
        score: [0, 0],
        fouls: [0, 0],
        period: 1,
        poss: 0,
        paused: true,
        clockSync: { startedAt: Date.now(), valueAtStart: 600, running: false },
        shotSync: { startedAt: Date.now(), valueAtStart: 24, running: false },
        pending: { team: 0, val: 1 }, // this should be stripped before browsers see it
    };
    device.send(JSON.stringify(state1));
    await wait(100);

    // ── Test 3: Browser connects, receives cached state immediately ───────────
    console.log("\nTest 3: Browser receives cached state on connect");
    let browserReceived = [];
    const browser = new WebSocket(`${BASE}?role=browser&id=${SESSION}`);
    await new Promise((r) => browser.on("open", r));
    browser.on("message", (raw) => {
        browserReceived.push(JSON.parse(raw));
    });
    await wait(100);

    const cachedMsg = browserReceived.find((m) => m.cached === true);
    assert(cachedMsg !== undefined, "browser received cached state on connect");
    assert(cachedMsg?.pending === undefined, "pending field stripped from cached state");
    assert(cachedMsg?.score?.[0] === 0, "score value correct");

    // ── Test 4: Device sends update, browser receives it ─────────────────────
    console.log("\nTest 4: Live state update reaches browser");
    browserReceived = [];
    const state2 = { ...state1, seq: 2, score: [2, 0] };
    device.send(JSON.stringify(state2));
    await wait(100);

    const liveMsg = browserReceived.find((m) => m.t === "state");
    assert(liveMsg !== undefined, "browser received live state update");
    assert(liveMsg?.score?.[0] === 2, "updated score value correct");
    assert(liveMsg?.pending === undefined, "pending stripped from live update");

    // ── Test 5: Stale seq is dropped ─────────────────────────────────────────
    console.log("\nTest 5: Stale sequence number dropped");
    browserReceived = [];
    const staleState = { ...state1, seq: 1, score: [99, 99] }; // seq=1 already seen
    device.send(JSON.stringify(staleState));
    await wait(100);

    const staleMsg = browserReceived.find((m) => m.score?.[0] === 99);
    assert(staleMsg === undefined, "stale message was dropped (score 99 not received)");

    // ── Test 6: Ping/pong ─────────────────────────────────────────────────────
    console.log("\nTest 6: Ping/pong");
    let pongReceived = false;
    device.on("message", (raw) => {
        const msg = JSON.parse(raw);
        if (msg.t === "pong") pongReceived = true;
    });
    device.send(JSON.stringify({ t: "ping", ts: Date.now() }));
    await wait(100);
    assert(pongReceived, "pong received after ping");

    // ── Test 7: Health endpoint ───────────────────────────────────────────────
    console.log("\nTest 7: Health check endpoint");
    const res = await fetch("http://localhost:3000/health");
    const health = await res.json();
    assert(health.status === "ok", "health endpoint returns ok");
    assert(health.sessions >= 1, "health reports active sessions");

    // ── Cleanup ───────────────────────────────────────────────────────────────
    device.close();
    browser.close();
    await wait(100);

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed === 0) {
        console.log("All tests passed. Relay is ready to deploy.\n");
    } else {
        console.error("Some tests failed. Fix before deploying.\n");
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test suite error:", err);
    process.exit(1);
});