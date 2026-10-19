/*
 * 🛸 DRONE CONTROLLER v1.0
 *
 * PROTOCOL CRACKED:
 *   Port 5007 (TCP) — Syma-like binary protocol
 *   Init:  0xA0 → Reply: 0xA1 (36 bytes telemetry)
 *   Port 7070 (TCP) — Video stream (raw or RTSP)
 *
 * CONTROLS:
 *   W/S     = Pitch (forward/backward)
 *   A/D     = Roll (left/right)
 *   ↑/↓     = Throttle (up/down)
 *   ←/→     = Yaw (rotate left/right)
 *   T       = Takeoff
 *   L       = Land
 *   SPACE   = Emergency stop
 *   Q       = Quit
 */

const net = require('net');
const readline = require('readline');

const DRONE = '192.168.1.1';
const CMD_PORT = 5007;

// ─── Joystick State ──────────────────────────────────────
let throttle = 0x00;   // 0x00 = min, 0xFF = max
let yaw      = 0x80;   // 0x80 = center
let pitch    = 0x80;   // 0x80 = center
let roll     = 0x80;   // 0x80 = center
let flags    = 0x00;   // bit flags for special commands

// Flag bits (common Syma-like)
const FLAG_TAKEOFF   = 0x01;
const FLAG_LAND      = 0x02;
const FLAG_HEADLESS  = 0x04;
const FLAG_EMERGENCY = 0x08;
const FLAG_CALIBRATE = 0x10;
const FLAG_FLIP      = 0x20;

// Step size for joystick changes
const STEP = 20;
const THROTTLE_STEP = 10;

let connected = false;
let sock = null;
let telemetryData = null;
let packetsSent = 0;
let repliesReceived = 0;

// ─── Build control packet ────────────────────────────────
function buildPacket() {
  // Try multiple possible packet formats and see which one the drone responds to
  // Format 1: Header + 4 axes + flags + padding + checksum
  const buf = Buffer.alloc(8);
  buf[0] = 0xA0;              // Header
  buf[1] = throttle & 0xFF;   // Throttle
  buf[2] = yaw & 0xFF;        // Yaw
  buf[3] = pitch & 0xFF;      // Pitch
  buf[4] = roll & 0xFF;       // Roll
  buf[5] = flags & 0xFF;      // Flags
  buf[6] = 0x00;              // Reserved
  // Checksum: XOR of all bytes
  let checksum = 0;
  for (let i = 0; i < 7; i++) checksum ^= buf[i];
  buf[7] = checksum & 0xFF;
  return buf;
}

// ─── Parse telemetry ─────────────────────────────────────
function parseTelemetry(data) {
  if (data.length < 2) return null;

  const info = {
    header: data[0],
    raw: data.toString('hex'),
    length: data.length,
  };

  // Try to extract common telemetry fields
  if (data.length >= 8) {
    info.byte1 = data[1];  // Often battery or status
    info.byte2 = data[2];  // Often height
    info.byte3 = data[3];
    info.byte4 = data[4];
    info.byte5 = data[5];
    info.byte6 = data[6];
    info.byte7 = data[7];
  }

  return info;
}

// ─── Connect to drone ────────────────────────────────────
function connectToDrone() {
  return new Promise((resolve, reject) => {
    sock = new net.Socket();
    sock.setTimeout(30000);

    sock.on('connect', () => {
      console.log('  ✅ TCP connection established!');
      console.log('  Sending init handshake (0xA0)...');

      // Send init
      const init = Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      sock.write(init);
    });

    sock.on('data', (data) => {
      repliesReceived++;
      telemetryData = parseTelemetry(data);

      if (!connected && data[0] === 0xA1) {
        connected = true;
        console.log(`  🎉 Drone acknowledged! (0xA1, ${data.length} bytes)`);
        console.log(`  Telemetry HEX: ${data.toString('hex')}`);
        console.log('');
        resolve();
      }
    });

    sock.on('timeout', () => {
      console.log('  ⚠️ Connection timeout');
    });

    sock.on('error', (err) => {
      console.log(`  ❌ Connection error: ${err.message}`);
      reject(err);
    });

    sock.on('close', () => {
      console.log('  Connection closed.');
      connected = false;
    });

    sock.connect(CMD_PORT, DRONE);
  });
}

// ─── Control loop (send packets at 20Hz) ─────────────────
let controlInterval = null;

function startControlLoop() {
  controlInterval = setInterval(() => {
    if (!connected || !sock) return;

    const packet = buildPacket();
    try {
      sock.write(packet);
      packetsSent++;
    } catch(e) {}

    // Clear one-shot flags after sending
    flags &= ~(FLAG_TAKEOFF | FLAG_LAND | FLAG_EMERGENCY | FLAG_FLIP | FLAG_CALIBRATE);
  }, 50); // 20Hz
}

// ─── Display HUD ─────────────────────────────────────────
function drawHUD() {
  setInterval(() => {
    if (!connected) return;

    const bar = (val, label) => {
      const pct = ((val / 255) * 100).toFixed(0);
      const filled = Math.round(val / 255 * 20);
      return `${label}: [${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${pct}%`;
    };

    process.stdout.write('\x1B[2J\x1B[H'); // Clear screen

    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  🛸 DRONE CONTROLLER — CONNECTED                    ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  ${bar(throttle, 'THR')}  ║`);
    console.log(`║  ${bar(yaw,      'YAW')}  ║`);
    console.log(`║  ${bar(pitch,    'PIT')}  ║`);
    console.log(`║  ${bar(roll,     'ROL')}  ║`);
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Packets sent: ${String(packetsSent).padEnd(10)} Replies: ${String(repliesReceived).padEnd(10)}║`);
    if (telemetryData) {
      console.log(`║  Telemetry: ${telemetryData.raw.substring(0, 36).padEnd(39)}║`);
    }
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  W/S = Forward/Back    ↑/↓ = Throttle Up/Down      ║');
    console.log('║  A/D = Left/Right      ←/→ = Yaw Left/Right        ║');
    console.log('║  T = Takeoff   L = Land   SPACE = Emergency Stop    ║');
    console.log('║  C = Calibrate   Q = Quit                           ║');
    console.log('╚══════════════════════════════════════════════════════╝');
  }, 200); // 5Hz refresh
}

// ─── Keyboard input ──────────────────────────────────────
function setupKeyboard() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    // Quit
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      console.log('\n\n  Landing and disconnecting...');
      flags |= FLAG_LAND;
      const pkt = buildPacket();
      if (sock) {
        sock.write(pkt);
        setTimeout(() => {
          if (controlInterval) clearInterval(controlInterval);
          sock.destroy();
          process.exit(0);
        }, 500);
      } else {
        process.exit(0);
      }
      return;
    }

    switch (key.name) {
      // Throttle
      case 'up':
        throttle = Math.min(255, throttle + THROTTLE_STEP);
        break;
      case 'down':
        throttle = Math.max(0, throttle - THROTTLE_STEP);
        break;

      // Yaw
      case 'left':
        yaw = Math.max(0, yaw - STEP);
        break;
      case 'right':
        yaw = Math.min(255, yaw + STEP);
        break;

      // Pitch
      case 'w':
        pitch = Math.max(0, pitch - STEP);  // Forward = lower value
        break;
      case 's':
        pitch = Math.min(255, pitch + STEP); // Backward = higher value
        break;

      // Roll
      case 'a':
        roll = Math.max(0, roll - STEP);
        break;
      case 'd':
        roll = Math.min(255, roll + STEP);
        break;

      // Special commands
      case 't':
        console.log('  >>> TAKEOFF <<<');
        flags |= FLAG_TAKEOFF;
        throttle = 0x80; // Set throttle to mid
        break;
      case 'l':
        console.log('  >>> LAND <<<');
        flags |= FLAG_LAND;
        throttle = 0x00;
        break;
      case 'space':
        console.log('  >>> EMERGENCY STOP <<<');
        flags |= FLAG_EMERGENCY;
        throttle = 0x00;
        pitch = 0x80;
        roll = 0x80;
        yaw = 0x80;
        break;
      case 'c':
        console.log('  >>> CALIBRATE <<<');
        flags |= FLAG_CALIBRATE;
        break;

      // Auto-center when releasing
      default:
        // If no directional key, drift back to center
        break;
    }

    // Auto-return pitch/roll/yaw to center over time
    // (implemented in the next section)
  });

  // Gradual return to center for pitch, roll, yaw
  setInterval(() => {
    if (pitch > 0x80) pitch = Math.max(0x80, pitch - 2);
    if (pitch < 0x80) pitch = Math.min(0x80, pitch + 2);
    if (roll > 0x80) roll = Math.max(0x80, roll - 2);
    if (roll < 0x80) roll = Math.min(0x80, roll + 2);
    if (yaw > 0x80) yaw = Math.max(0x80, yaw - 2);
    if (yaw < 0x80) yaw = Math.min(0x80, yaw + 2);
  }, 100);
}

// ─── Exploration mode: try different packet formats ──────
async function exploreProtocol() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  PROTOCOL EXPLORATION — Finding the right format     ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // We know 0xA0 works. Let's see what other headers get replies.
  const testHeaders = [
    0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
    0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF,
    0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5,
    0x00, 0x01, 0x02, 0x10, 0x20, 0x30, 0x40, 0x50,
    0x60, 0x66, 0x70, 0x80, 0x90, 0xCC, 0xEF, 0xFF,
  ];

  for (const header of testHeaders) {
    const pkt = Buffer.from([header, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    await new Promise((resolve) => {
      const s = new net.Socket();
      s.setTimeout(500);
      let replied = false;

      s.on('connect', () => {
        s.write(pkt);
      });

      s.on('data', (data) => {
        replied = true;
        console.log(`  0x${header.toString(16).padStart(2,'0')} → REPLY! (${data.length}B) Header=0x${data[0].toString(16).padStart(2,'0')}  HEX=${data.toString('hex').substring(0, 40)}`);
        s.destroy();
      });

      s.on('timeout', () => { s.destroy(); });
      s.on('error', () => {});
      s.on('close', () => {
        if (!replied) {
          process.stdout.write(`  0x${header.toString(16).padStart(2,'0')} → silent  |  `);
        }
        setTimeout(resolve, 50);
      });

      s.connect(CMD_PORT, DRONE);
    });
  }

  console.log('\n');
}

// ─── MAIN ────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  🛸 DRONE CONTROLLER v1.0                            ║');
  console.log('║  Protocol: Syma-like (0xA0/0xA1)                     ║');
  console.log('║  Target: 192.168.1.1:5007                            ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Phase 1: Explore protocol (find all valid commands) ║');
  console.log('║  Phase 2: Connect and fly!                            ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Phase 1: Explore what commands the drone accepts
  await exploreProtocol();

  // Phase 2: Connect and start control
  console.log('  Connecting to drone for flight control...\n');

  try {
    await connectToDrone();
  } catch(e) {
    console.log(`  Failed to connect: ${e.message}`);
    process.exit(1);
  }

  startControlLoop();
  setupKeyboard();
  drawHUD();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
