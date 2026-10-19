/*
 * 🛸 DRONE CONTROLLER v2.0
 *
 * WHAT WE LEARNED:
 *   - Only 0xA0 gets a reply (0xA1 + 36 bytes)
 *   - Connection drops FAST if we stop sending
 *   - All telemetry was zeros → drone hasn't been "activated" yet
 *
 * FIX: Start sending packets IMMEDIATELY, never stop.
 *   - The payload bytes (1-6) must contain stick values + flags
 *   - We send 0xA0 packets at 20Hz continuously
 *   - If connection drops, reconnect instantly
 *
 * PHASE 1: Keep-alive test (just hold the connection)
 * PHASE 2: Payload exploration (try different byte patterns)
 * PHASE 3: Flight control (if we find working patterns)
 */

const net = require('net');
const readline = require('readline');

const DRONE = '192.168.1.1';
const CMD_PORT = 5007;
const SEND_RATE_MS = 50; // 20 Hz

let sock = null;
let connected = false;
let packetsSent = 0;
let repliesReceived = 0;
let lastTelemetry = '';
let lastTelemetryChanged = false;

// Joystick state
let throttle = 0x00;
let yaw      = 0x80;
let pitch    = 0x80;
let roll     = 0x80;
let flags    = 0x00;

function ts() { return new Date().toLocaleTimeString(); }

// ─── Build & send a control packet ───────────────────────
function buildPacket() {
  const buf = Buffer.alloc(8);
  buf[0] = 0xA0;
  buf[1] = throttle & 0xFF;
  buf[2] = yaw & 0xFF;
  buf[3] = pitch & 0xFF;
  buf[4] = roll & 0xFF;
  buf[5] = flags & 0xFF;
  buf[6] = 0x00;
  // XOR checksum of bytes 0-6
  let cs = 0;
  for (let i = 0; i < 7; i++) cs ^= buf[i];
  buf[7] = cs & 0xFF;
  return buf;
}

// ─── Connect and IMMEDIATELY start sending ───────────────
function connect() {
  return new Promise((resolve) => {
    if (sock) { try { sock.destroy(); } catch(e) {} }

    sock = new net.Socket();
    sock.setNoDelay(true); // Disable Nagle's — send immediately
    sock.setTimeout(0);    // No timeout — WE control the lifecycle

    sock.on('connect', () => {
      connected = true;
      console.log(`  [${ts()}] ✅ Connected! Sending init + starting heartbeat...`);

      // Send init IMMEDIATELY
      sock.write(Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      packetsSent++;

      // Start sending control packets IMMEDIATELY (don't wait for reply)
      const interval = setInterval(() => {
        if (!connected) { clearInterval(interval); return; }
        try {
          sock.write(buildPacket());
          packetsSent++;
        } catch(e) {
          clearInterval(interval);
        }
      }, SEND_RATE_MS);

      resolve();
    });

    sock.on('data', (data) => {
      repliesReceived++;
      const hex = data.toString('hex');

      if (hex !== lastTelemetry) {
        lastTelemetryChanged = true;
        lastTelemetry = hex;
        // Print when telemetry CHANGES (important for understanding the data)
        console.log(`  [${ts()}] 📨 Telemetry changed! (${data.length}B): ${hex.substring(0, 72)}`);

        // Look for non-zero bytes (actual data)
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== 0x00 && data[i] !== 0xA1) {
            console.log(`         Byte[${i}] = 0x${data[i].toString(16).padStart(2,'0')} (${data[i]})`);
          }
        }
      }
    });

    sock.on('close', () => {
      connected = false;
      console.log(`  [${ts()}] ⚠️ Connection closed. Reconnecting in 500ms...`);
      console.log(`         (Sent: ${packetsSent}, Received: ${repliesReceived})`);
      setTimeout(connect, 500);
    });

    sock.on('error', (err) => {
      connected = false;
      console.log(`  [${ts()}] ❌ Error: ${err.message}. Reconnecting...`);
      setTimeout(connect, 1000);
    });

    sock.connect(CMD_PORT, DRONE);
  });
}

// ─── Keyboard controls ──────────────────────────────────
function setupKeyboard() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      console.log('\n  Quitting...');
      if (sock) sock.destroy();
      process.exit(0);
    }

    const STEP = 20;
    const TSTEP = 10;

    switch (key.name) {
      case 'up':    throttle = Math.min(255, throttle + TSTEP); break;
      case 'down':  throttle = Math.max(0, throttle - TSTEP); break;
      case 'left':  yaw = Math.max(0, yaw - STEP); break;
      case 'right': yaw = Math.min(255, yaw + STEP); break;
      case 'w':     pitch = Math.max(0, pitch - STEP); break;
      case 's':     pitch = Math.min(255, pitch + STEP); break;
      case 'a':     roll = Math.max(0, roll - STEP); break;
      case 'd':     roll = Math.min(255, roll + STEP); break;
      case 't':
        console.log('  >>> TAKEOFF <<<');
        flags |= 0x01;
        throttle = 128;
        break;
      case 'l':
        console.log('  >>> LAND <<<');
        flags |= 0x02;
        throttle = 0;
        break;
      case 'space':
        console.log('  >>> EMERGENCY STOP <<<');
        flags |= 0x08;
        throttle = 0; pitch = 128; roll = 128; yaw = 128;
        break;
      case 'c':
        console.log('  >>> CALIBRATE <<<');
        flags |= 0x10;
        break;
      case 'i':
        // Print current status
        console.log(`  THR=${throttle} YAW=${yaw} PIT=${pitch} ROL=${roll} FLAGS=0x${flags.toString(16)}`);
        console.log(`  Sent=${packetsSent} Recv=${repliesReceived}`);
        console.log(`  Last telemetry: ${lastTelemetry.substring(0, 72)}`);
        break;
    }
  });

  // Auto-center pitch/roll/yaw
  setInterval(() => {
    if (pitch > 128) pitch = Math.max(128, pitch - 3);
    if (pitch < 128) pitch = Math.min(128, pitch + 3);
    if (roll > 128) roll = Math.max(128, roll - 3);
    if (roll < 128) roll = Math.min(128, roll + 3);
    if (yaw > 128) yaw = Math.max(128, yaw - 3);
    if (yaw < 128) yaw = Math.min(128, yaw + 3);

    // Clear one-shot flags
    flags &= ~(0x01 | 0x02 | 0x08 | 0x10);
  }, 100);
}

// ─── Status ticker (non-clearing, so we don't lose data) ──
function startStatusTicker() {
  setInterval(() => {
    if (!connected) return;
    process.stdout.write(`\r  [LIVE] Sent:${packetsSent} Recv:${repliesReceived} THR:${throttle} YAW:${yaw} PIT:${pitch} ROL:${roll}   `);
  }, 500);
}

// ─── MAIN ────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  🛸 DRONE CONTROLLER v2.0 — Persistent Connection    ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Protocol: 0xA0 (Syma-like) on TCP 5007             ║');
  console.log('║  Sends control packets at 20Hz (never stops)        ║');
  console.log('║  Auto-reconnects if connection drops                 ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  W/S     = Forward / Backward                       ║');
  console.log('║  A/D     = Left / Right (roll)                      ║');
  console.log('║  ↑/↓     = Throttle Up / Down                       ║');
  console.log('║  ←/→     = Yaw Left / Right                         ║');
  console.log('║  T       = Takeoff                                   ║');
  console.log('║  L       = Land                                      ║');
  console.log('║  SPACE   = Emergency Stop                            ║');
  console.log('║  C       = Calibrate Gyro                            ║');
  console.log('║  I       = Show status info                          ║');
  console.log('║  Q       = Quit                                      ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  setupKeyboard();

  console.log(`  [${ts()}] Connecting to ${DRONE}:${CMD_PORT}...\n`);
  await connect();

  startStatusTicker();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
