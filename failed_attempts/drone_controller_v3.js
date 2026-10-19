/*
 * 🛸 DRONE CONTROLLER v3.0 — THE REAL PROTOCOL
 *
 * BASED ON: martin-ger/ESP_E58-Drone reverse engineering
 *
 * KEY INSIGHT: The E58/KY UFO/FLOW-UFO protocol uses UDP, NOT TCP!
 *   - TCP 5007 = Firmware upgrade only ("Upgrade_ok")
 *   - TCP 7070 = RTSP stub (not used for actual video)
 *
 * REAL PROTOCOL:
 *   UDP 40000 = Heartbeat  (63 63 01 00 00 00 00)
 *   UDP 50000 = Flight control (0x66 ... 0x99 packets)
 *   UDP  8800 = Video start command (EF 00 04 00)
 *
 * CONTROLS:
 *   W/S     = Pitch (forward/backward)
 *   A/D     = Roll (left/right)
 *   ↑/↓     = Throttle (up/down)
 *   ←/→     = Yaw (rotate)
 *   T       = Takeoff
 *   L       = Land
 *   U       = Unlock motors
 *   K       = Lock motors
 *   SPACE   = Emergency stop
 *   C       = Calibrate gyro
 *   H       = Toggle headless mode
 *   Q       = Quit
 */

const dgram = require('dgram');
const readline = require('readline');

const DRONE = '192.168.1.1';
const HEARTBEAT_PORT = 40000;
const CONTROL_PORT = 50000;
const VIDEO_PORT = 8800;

// Joystick state (128 = center for all)
let roll     = 128;
let pitch    = 128;
let throttle = 0;    // Start at 0 (grounded)
let yaw      = 128;
let cmdBits  = 0x00;

// Command bit flags (from ESP_E58-Drone source)
const CMD_TAKEOFF   = 0x01;
const CMD_LAND      = 0x02;
const CMD_EMERGENCY = 0x04;
const CMD_FLIP      = 0x08;
const CMD_HEADLESS  = 0x10;
const CMD_LOCK      = 0x20;
const CMD_UNLOCK    = 0x40;
const CMD_CALIBRATE = 0x80;

let headlessMode = false;
let packetsSent = 0;
let heartbeatsSent = 0;
let droneReplied = false;
let lastReplyTime = 0;

function ts() { return new Date().toLocaleTimeString(); }

// ─── Create UDP socket ───────────────────────────────────
const sock = dgram.createSocket('udp4');

sock.on('message', (msg, rinfo) => {
  droneReplied = true;
  lastReplyTime = Date.now();
  const hex = msg.toString('hex');

  // Only print if it's meaningful (not just silence)
  if (msg.length > 0) {
    console.log(`\n  📨 [${ts()}] DRONE REPLY from :${rinfo.port} (${msg.length}B): ${hex.substring(0, 60)}`);
  }
});

sock.on('error', (err) => {
  console.log(`  Socket error: ${err.message}`);
});

// ─── Build flight control packet ─────────────────────────
//  Byte 0: 0x66         (header)
//  Byte 1: Roll         (0-254, 128 = center)
//  Byte 2: Pitch        (0-254, 128 = center)
//  Byte 3: Throttle     (0-254, 0 = off, 128 = hover)
//  Byte 4: Yaw          (0-254, 128 = center)
//  Byte 5: Command bits
//  Byte 6: Checksum     (XOR of bytes 1-4)
//  Byte 7: 0x99         (footer)
function buildControlPacket() {
  const r = roll & 0xFF;
  const p = pitch & 0xFF;
  const t = throttle & 0xFF;
  const y = yaw & 0xFF;
  const checksum = (r ^ p ^ t ^ y) & 0xFF;

  return Buffer.from([0x66, r, p, t, y, cmdBits & 0xFF, checksum, 0x99]);
}

// ─── Build heartbeat packet ──────────────────────────────
function buildHeartbeat() {
  return Buffer.from([0x63, 0x63, 0x01, 0x00, 0x00, 0x00, 0x00]);
}

// ─── Build video start command ───────────────────────────
function buildVideoStart() {
  return Buffer.from([0xEF, 0x00, 0x04, 0x00]);
}

// ─── Send UDP packet ─────────────────────────────────────
function send(buf, port) {
  sock.send(buf, 0, buf.length, port, DRONE, (err) => {
    if (err) console.log(`  Send error to port ${port}: ${err.message}`);
  });
}

// ─── Heartbeat loop (1 Hz to port 40000) ─────────────────
function startHeartbeat() {
  setInterval(() => {
    send(buildHeartbeat(), HEARTBEAT_PORT);
    heartbeatsSent++;
  }, 1000);

  // Send first one immediately
  send(buildHeartbeat(), HEARTBEAT_PORT);
  heartbeatsSent++;
  console.log(`  [${ts()}] Heartbeat started → UDP ${HEARTBEAT_PORT}`);
}

// ─── Control loop (20 Hz to port 50000) ──────────────────
function startControlLoop() {
  setInterval(() => {
    send(buildControlPacket(), CONTROL_PORT);
    packetsSent++;

    // Clear one-shot command flags after sending
    cmdBits &= ~(CMD_TAKEOFF | CMD_LAND | CMD_EMERGENCY | CMD_FLIP | CMD_CALIBRATE | CMD_LOCK | CMD_UNLOCK);
  }, 50);

  // Send first one immediately
  send(buildControlPacket(), CONTROL_PORT);
  packetsSent++;
  console.log(`  [${ts()}] Control loop started → UDP ${CONTROL_PORT}`);
}

// ─── Video start ─────────────────────────────────────────
function requestVideo() {
  send(buildVideoStart(), VIDEO_PORT);
  console.log(`  [${ts()}] Video start sent → UDP ${VIDEO_PORT}`);
}

// ─── Keyboard controls ──────────────────────────────────
function setupKeyboard() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const STEP = 25;
  const TSTEP = 15;

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      console.log('\n\n  Sending LAND command and exiting...');
      cmdBits |= CMD_LAND;
      throttle = 0;
      send(buildControlPacket(), CONTROL_PORT);
      setTimeout(() => {
        sock.close();
        process.exit(0);
      }, 300);
      return;
    }

    switch (key.name) {
      // Throttle (arrow up/down)
      case 'up':    throttle = Math.min(254, throttle + TSTEP); break;
      case 'down':  throttle = Math.max(0, throttle - TSTEP); break;

      // Yaw (arrow left/right)
      case 'left':  yaw = Math.max(0, yaw - STEP); break;
      case 'right': yaw = Math.min(254, yaw + STEP); break;

      // Pitch (W/S)
      case 'w':     pitch = Math.max(0, pitch - STEP); break;   // Forward
      case 's':     pitch = Math.min(254, pitch + STEP); break;  // Backward

      // Roll (A/D)
      case 'a':     roll = Math.max(0, roll - STEP); break;     // Left
      case 'd':     roll = Math.min(254, roll + STEP); break;   // Right

      // Commands
      case 't':
        console.log('\n  🚀 TAKEOFF');
        cmdBits |= CMD_TAKEOFF;
        throttle = 128;
        break;
      case 'l':
        console.log('\n  🛬 LAND');
        cmdBits |= CMD_LAND;
        throttle = 0;
        break;
      case 'u':
        console.log('\n  🔓 UNLOCK MOTORS');
        cmdBits |= CMD_UNLOCK;
        break;
      case 'k':
        console.log('\n  🔒 LOCK MOTORS');
        cmdBits |= CMD_LOCK;
        break;
      case 'space':
        console.log('\n  🛑 EMERGENCY STOP');
        cmdBits |= CMD_EMERGENCY;
        throttle = 0;
        pitch = 128; roll = 128; yaw = 128;
        break;
      case 'c':
        console.log('\n  🔧 CALIBRATE GYRO');
        cmdBits |= CMD_CALIBRATE;
        break;
      case 'h':
        headlessMode = !headlessMode;
        if (headlessMode) cmdBits |= CMD_HEADLESS;
        console.log(`\n  Headless mode: ${headlessMode ? 'ON' : 'OFF'}`);
        break;
      case 'v':
        requestVideo();
        break;
      case 'i':
        console.log(`\n  THR=${throttle} YAW=${yaw} PIT=${pitch} ROL=${roll}`);
        console.log(`  CMD=0x${cmdBits.toString(16)} Pkts=${packetsSent} HB=${heartbeatsSent}`);
        console.log(`  Drone replied: ${droneReplied ? 'YES' : 'not yet'}`);
        break;
    }
  });

  // Auto-center pitch/roll/yaw when keys released
  setInterval(() => {
    if (pitch > 128) pitch = Math.max(128, pitch - 4);
    if (pitch < 128) pitch = Math.min(128, pitch + 4);
    if (roll > 128) roll = Math.max(128, roll - 4);
    if (roll < 128) roll = Math.min(128, roll + 4);
    if (yaw > 128) yaw = Math.max(128, yaw - 4);
    if (yaw < 128) yaw = Math.min(128, yaw + 4);
  }, 80);
}

// ─── Status ticker ───────────────────────────────────────
function startTicker() {
  setInterval(() => {
    const ago = droneReplied ? `${((Date.now() - lastReplyTime)/1000).toFixed(0)}s ago` : 'never';
    process.stdout.write(`\r  [LIVE] THR:${throttle} YAW:${yaw} PIT:${pitch} ROL:${roll} | Pkts:${packetsSent} HB:${heartbeatsSent} | Reply:${ago}   `);
  }, 500);
}

// ─── MAIN ────────────────────────────────────────────────
function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🛸 DRONE CONTROLLER v3.0 — REAL E58 UDP PROTOCOL       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Heartbeat → UDP 40000 (1 Hz)                           ║');
  console.log('║  Controls  → UDP 50000 (20 Hz)                          ║');
  console.log('║  Video cmd → UDP 8800                                    ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  W/S     = Forward / Backward                           ║');
  console.log('║  A/D     = Left / Right (roll)                          ║');
  console.log('║  ↑/↓     = Throttle Up / Down                           ║');
  console.log('║  ←/→     = Yaw Left / Right                             ║');
  console.log('║  T=Takeoff  L=Land  U=Unlock  K=Lock  SPACE=Emergency   ║');
  console.log('║  C=Calibrate  H=Headless  V=Video  I=Info  Q=Quit       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // IMPORTANT: Disable Windows Firewall or set network to Private!
  console.log('  ⚠️  Make sure Windows Firewall is OFF (or network is Private)!\n');

  sock.bind(0, () => {
    console.log(`  [${ts()}] Socket bound to local port ${sock.address().port}`);

    // Start all systems
    startHeartbeat();
    startControlLoop();

    // Request video too
    requestVideo();

    // Keyboard
    setupKeyboard();
    startTicker();

    console.log(`\n  ✅ All systems running! Waiting for drone response...`);
    console.log('  (If no reply in 10s, check: Firewall OFF + connected to drone WiFi)\n');
  });
}

main();
