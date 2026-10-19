/*
 * 🛸 DRONE CONTROLLER v5.0 — THE "A1" HANDSHAKE
 *
 * We now know the exact sequence for this specific FLOW-UFO variant:
 *   1. Connect to TCP 5007.
 *   2. Send 0xA0 00 00 00 00 00 00 00
 *   3. Drone replies with 36 bytes starting with 0xA1.
 *   4. IMMEDIATEY start sending flight control packets (0x66 format).
 *
 * The previous version failed because it waited for the string "Upgrade_ok",
 * which this firmware variant doesn't actually send!
 */

const net = require('net');
const readline = require('readline');

const DRONE = '192.168.1.1';
const CMD_PORT = 5007;

let roll = 128, pitch = 128, throttle = 0, yaw = 128, cmdBits = 0x00;
let packetsSent = 0;
let headlessMode = false;

// Flags
const CMD_TAKEOFF   = 0x01;
const CMD_LAND      = 0x02;
const CMD_EMERGENCY = 0x04;
const CMD_LOCK      = 0x20;
const CMD_UNLOCK    = 0x40;
const CMD_CALIBRATE = 0x80;

function ts() { return new Date().toLocaleTimeString(); }

function buildControlPacket() {
  const r = roll & 0xFF, p = pitch & 0xFF, t = throttle & 0xFF, y = yaw & 0xFF;
  const checksum = (r ^ p ^ t ^ y) & 0xFF;
  return Buffer.from([0x66, r, p, t, y, cmdBits & 0xFF, checksum, 0x99]);
}

function setupKeyboard(sock) {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const STEP = 25, TSTEP = 15;

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      console.log('\n\n  Sending LAND command and exiting...');
      cmdBits |= CMD_LAND; throttle = 0;
      try { sock.write(buildControlPacket()); } catch(e){}
      setTimeout(() => process.exit(0), 300);
      return;
    }

    switch (key.name) {
      case 'up':    throttle = Math.min(254, throttle + TSTEP); break;
      case 'down':  throttle = Math.max(0, throttle - TSTEP); break;
      case 'left':  yaw = Math.max(0, yaw - STEP); break;
      case 'right': yaw = Math.min(254, yaw + STEP); break;
      case 'w':     pitch = Math.max(0, pitch - STEP); break;
      case 's':     pitch = Math.min(254, pitch + STEP); break;
      case 'a':     roll = Math.max(0, roll - STEP); break;
      case 'd':     roll = Math.min(254, roll + STEP); break;

      case 't':     cmdBits |= CMD_TAKEOFF; throttle = 128; break;
      case 'l':     cmdBits |= CMD_LAND; throttle = 0; break;
      case 'u':     cmdBits |= CMD_UNLOCK; break;
      case 'k':     cmdBits |= CMD_LOCK; break;
      case 'space': cmdBits |= CMD_EMERGENCY; throttle = 0; pitch=128; roll=128; yaw=128; break;
      case 'c':     cmdBits |= CMD_CALIBRATE; break;
    }
  });

  // Auto-center
  setInterval(() => {
    if (pitch > 128) pitch = Math.max(128, pitch - 4);
    if (pitch < 128) pitch = Math.min(128, pitch + 4);
    if (roll > 128) roll = Math.max(128, roll - 4);
    if (roll < 128) roll = Math.min(128, roll + 4);
    if (yaw > 128) yaw = Math.max(128, yaw - 4);
    if (yaw < 128) yaw = Math.min(128, yaw + 4);
  }, 80);
}

function startTicker() {
  setInterval(() => {
    process.stdout.write(`\r  [LIVE] THR:${throttle.toString().padStart(3)} YAW:${yaw.toString().padStart(3)} PIT:${pitch.toString().padStart(3)} ROL:${roll.toString().padStart(3)} | Pkts:${packetsSent}   `);
  }, 200);
}

function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🛸 DRONE CONTROLLER v5.0 — THE "A1" HANDSHAKE          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const sock = new net.Socket();
  sock.setNoDelay(true);

  let state = 'CONNECTING';
  let controlInterval = null;

  sock.on('connect', () => {
    console.log(`  [${ts()}] ✅ Connected to TCP 5007`);
    console.log(`  [${ts()}] Sending 0xA0 handshake...`);
    sock.write(Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    state = 'WAITING_A1';
  });

  sock.on('data', (data) => {
    if (state === 'WAITING_A1' && data[0] === 0xA1) {
      console.log(`  [${ts()}] 📨 Got 0xA1 handshake reply!`);
      console.log(`  [${ts()}] 🚀 SWITCHING TO FLIGHT CONTROLS (0x66 format)\n`);
      state = 'CONTROLLING';

      setupKeyboard(sock);
      startTicker();

      controlInterval = setInterval(() => {
        try {
          sock.write(buildControlPacket());
          packetsSent++;
          cmdBits &= ~(CMD_TAKEOFF | CMD_LAND | CMD_EMERGENCY | CMD_CALIBRATE | CMD_LOCK | CMD_UNLOCK);
        } catch(e) {
          clearInterval(controlInterval);
        }
      }, 50); // 20Hz
    }
  });

  sock.on('close', () => {
    console.log(`\n\n  [${ts()}] ❌ Connection closed by drone! (Sent ${packetsSent} control packets)`);
    if (controlInterval) clearInterval(controlInterval);
    process.exit();
  });

  sock.on('error', (err) => {
    console.log(`\n  [${ts()}] ⚠️ Socket error: ${err.message}`);
  });

  sock.connect(CMD_PORT, DRONE);
}

main();
