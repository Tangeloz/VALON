#!/usr/bin/env node
// ============================================================================
//  DRONE CONTROLLER ΓÇö E99 / E58 / E88 Family ("WiFiCAM" app drones)
//  Node.js ΓÇö zero dependencies (dgram, readline, net only)
//
//  Usage:  node drone_controller.js
//
//  1. Connect your PC to the drone's WiFi AP
//  2. Run this script
//  3. Discovery mode runs for 5 seconds, then flight controls activate
// ============================================================================

'use strict';

const dgram    = require('dgram');
const readline = require('readline');

// ========================== CONFIGURATION ==================================
// Edit these if your drone uses different values

const DRONE_IP          = '192.168.1.1';   // Drone's IP on its own AP
const CONTROL_PORT      = 8800;            // UDP port for commands & video
const VIDEO_PORT        = 8800;            // UDP port for video stream (same on this family)

const CONTROL_INTERVAL  = 50;              // ms between control packets
const DISCOVERY_TIME    = 5000;            // ms to listen before enabling controls

// Video stream handshake (send this to start the video feed)
const VIDEO_HANDSHAKE   = Buffer.from([0xEF, 0x00, 0x04, 0x00]);

// ========================== PROTOCOL BYTES =================================
// Control packet: 8 bytes, sent every CONTROL_INTERVAL ms
//
//  Index  Value        Meaning
//  -----  -----------  -------------------------------------------------------
//  [0]    0x66         Header (fixed)
//  [1]    0x00ΓÇô0xFF    Roll      ΓÇö right stick left/right   (center = 0x80)
//  [2]    0x00ΓÇô0xFF    Pitch     ΓÇö right stick up/down      (center = 0x80)
//  [3]    0x00ΓÇô0xFF    Yaw       ΓÇö left stick left/right    (center = 0x80)
//  [4]    0x00ΓÇô0xFF    Throttle  ΓÇö left stick up/down       (center = 0x80)
//  [5]    0x00         Flags / buttons (trim, flip, headless, etc.)
//  [6]    0x00         Flags / buttons (speed mode, etc.)
//  [7]    0x99         Footer (fixed)
//
// If a control axis is inverted, swap the +/- key mappings below or
// change the STEP sign for that axis.

const HEADER = 0x66;  // Byte [0] ΓÇö fixed header
const FOOTER = 0x99;  // Byte [7] ΓÇö fixed footer

// Byte indices into the 8-byte control packet
const IDX_ROLL     = 1;  // Right stick left/right
const IDX_PITCH    = 2;  // Right stick up/down
const IDX_YAW      = 3;  // Left stick left/right
const IDX_THROTTLE = 4;  // Left stick up/down
const IDX_FLAGS1   = 5;  // Flags / buttons byte 1
const IDX_FLAGS2   = 6;  // Flags / buttons byte 2

// Control center point and step size
const CENTER   = 0x80;   // 128 ΓÇö neutral stick position
const STEP     = 30;     // How much each keypress moves the axis (0ΓÇô127 range)

// ========================== STATE ==========================================

const state = {
  roll:     CENTER,  // A/D
  pitch:    CENTER,  // W/S
  yaw:      CENTER,  // Q/E
  throttle: CENTER,  // Space/Shift

  armed:       false,
  connected:   false,
  packetsSent: 0,
  landing:     false,

  // Discovery
  discoveryDone:   false,
  discoveryPackets: new Map(),  // hex string ΓåÆ count

  // Last received packets (hex dump)
  received: [],  // array of { time, hex, from }
};

// Key tracking for held-key behavior
const keysDown = new Set();

// ========================== UDP SOCKET =====================================

const sock = dgram.createSocket('udp4');

sock.on('error', (err) => {
  console.error(`\n  Socket error: ${err.message}`);
  sock.close();
  process.exit(1);
});

sock.on('message', (msg, rinfo) => {
  const hex = msg.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ');
  const entry = {
    time: new Date().toLocaleTimeString(),
    hex,
    from: `${rinfo.address}:${rinfo.port}`,
    size: msg.length,
  };

  // Discovery mode ΓÇö collect unique packets
  if (!state.discoveryDone) {
    const key = hex;
    state.discoveryPackets.set(key, (state.discoveryPackets.get(key) || 0) + 1);
  }

  // Keep last 3 received packets for the HUD
  state.received.push(entry);
  if (state.received.length > 3) state.received.shift();

  state.connected = true;
});

// Bind to the same port so we can receive responses
sock.bind(CONTROL_PORT, '0.0.0.0', () => {
  sock.setBroadcast(true);
  console.log(`  Bound to UDP port ${CONTROL_PORT}`);
});

// ========================== PACKET BUILDER =================================

function buildControlPacket() {
  const buf = Buffer.alloc(8);

  buf[0] = HEADER;                           // [0] header
  buf[IDX_ROLL]     = clamp(state.roll);     // [1] roll
  buf[IDX_PITCH]    = clamp(state.pitch);    // [2] pitch
  buf[IDX_YAW]      = clamp(state.yaw);      // [3] yaw
  buf[IDX_THROTTLE] = clamp(state.throttle); // [4] throttle
  buf[IDX_FLAGS1]   = 0x00;                  // [5] flags1
  buf[IDX_FLAGS2]   = 0x00;                  // [6] flags2
  buf[7] = FOOTER;                           // [7] footer

  return buf;
}

function clamp(v) {
  return Math.max(0x00, Math.min(0xFF, Math.round(v)));
}

function sendControl() {
  const pkt = buildControlPacket();
  sock.send(pkt, 0, pkt.length, CONTROL_PORT, DRONE_IP, (err) => {
    if (!err) state.packetsSent++;
  });
}

function sendVideoHandshake() {
  sock.send(VIDEO_HANDSHAKE, 0, VIDEO_HANDSHAKE.length, VIDEO_PORT, DRONE_IP, (err) => {
    if (err) console.error(`  Video handshake error: ${err.message}`);
  });
}

// ========================== DECAY / CENTERING ==============================
// Sticks spring back to center when keys are released

function decayAxis(axis) {
  const diff = state[axis] - CENTER;
  if (Math.abs(diff) < 2) {
    state[axis] = CENTER;
  } else {
    state[axis] -= diff * 0.3;  // spring-back speed
  }
}

function updateAxes() {
  // Apply held keys
  if (keysDown.has('w'))     state.pitch    = CENTER + STEP;    // Pitch forward
  if (keysDown.has('s'))     state.pitch    = CENTER - STEP;    // Pitch backward
  if (keysDown.has('a'))     state.roll     = CENTER - STEP;    // Roll left
  if (keysDown.has('d'))     state.roll     = CENTER + STEP;    // Roll right
  if (keysDown.has('q'))     state.yaw      = CENTER - STEP;    // Yaw left (rotate CCW)
  if (keysDown.has('e'))     state.yaw      = CENTER + STEP;    // Yaw right (rotate CW)
  if (keysDown.has('space')) state.throttle = Math.min(0xFF, state.throttle + 3);  // Throttle up
  if (keysDown.has('shift')) state.throttle = Math.max(0x00, state.throttle - 3);  // Throttle down

  // Decay axes back to center when keys are NOT held
  if (!keysDown.has('w') && !keysDown.has('s')) decayAxis('pitch');
  if (!keysDown.has('a') && !keysDown.has('d')) decayAxis('roll');
  if (!keysDown.has('q') && !keysDown.has('e')) decayAxis('yaw');
  // Throttle does NOT decay ΓÇö it holds its value (like a real throttle stick)
}

// ========================== TAKEOFF / LAND =================================

function takeoff() {
  console.log('\n  ≡ƒÜÇ TAKEOFF ΓÇö throttle burst');
  state.armed = true;
  state.throttle = CENTER + 60;  // Burst above hover
  // After 1.5s, settle to hover
  setTimeout(() => {
    state.throttle = CENTER + 20;  // Approximate hover
  }, 1500);
}

function land() {
  if (state.landing) return;
  console.log('\n  ≡ƒ¢¼ LANDING ΓÇö gradual throttle cut');
  state.landing = true;
  const landInterval = setInterval(() => {
    state.throttle -= 4;
    if (state.throttle <= 0) {
      state.throttle = 0;
      state.armed = false;
      state.landing = false;
      clearInterval(landInterval);
      console.log('  Γ£à Landed (throttle zero)');
    }
  }, 100);
}

function emergencyStop() {
  console.log('\n  ≡ƒ¢æ EMERGENCY STOP');
  state.roll     = CENTER;
  state.pitch    = CENTER;
  state.yaw      = CENTER;
  state.throttle = 0x00;
  state.armed    = false;
  state.landing  = false;
  keysDown.clear();
  // Send a burst of stop packets
  for (let i = 0; i < 10; i++) sendControl();
}

// ========================== KEYBOARD INPUT =================================

function setupKeyboard() {
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    // ESC = emergency stop
    if (key.name === 'escape') {
      emergencyStop();
      return;
    }

    // Ctrl+C = quit
    if (key.ctrl && key.name === 'c') {
      emergencyStop();
      console.log('\n  Exiting...');
      setTimeout(() => process.exit(0), 200);
      return;
    }

    if (!state.discoveryDone) return;  // Ignore keys during discovery

    const k = key.name || '';
    const kLower = k.toLowerCase();

    // Key down tracking
    if (kLower === 'space' || kLower === 'return') {
      keysDown.add('space');
    } else if (key.shift && !key.ctrl && !key.meta) {
      keysDown.add('shift');
    } else if (['w','a','s','d','q','e'].includes(kLower)) {
      keysDown.add(kLower);
    }

    // One-shot keys
    if (kLower === 't') takeoff();
    if (kLower === 'l') land();
    if (kLower === 'v') sendVideoHandshake();

    // Release tracking: since Node doesn't have keyup events, we use a
    // short timeout to auto-release directional keys
    if (['w','a','s','d','q','e'].includes(kLower)) {
      setTimeout(() => keysDown.delete(kLower), 150);
    }
    if (kLower === 'space') {
      setTimeout(() => keysDown.delete('space'), 150);
    }
    if (key.shift) {
      setTimeout(() => keysDown.delete('shift'), 150);
    }
  });
}

// ========================== TERMINAL HUD ===================================

function bar(value, width = 20) {
  const pct = value / 255;
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const c = value > CENTER + 10 ? '\x1b[32m' : value < CENTER - 10 ? '\x1b[31m' : '\x1b[36m';
  return `${c}${'Γûê'.repeat(filled)}\x1b[90m${'Γûæ'.repeat(empty)}\x1b[0m`;
}

function drawHUD() {
  const lines = [];

  lines.push('\x1b[2J\x1b[H');  // Clear screen, cursor to top
  lines.push('\x1b[1;36m  ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ\x1b[0m');
  lines.push('\x1b[1;37m   ≡ƒÜü  DRONE CONTROLLER  ΓÇö  E99 / E58 / E88 Family\x1b[0m');
  lines.push('\x1b[1;36m  ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ\x1b[0m');
  lines.push('');

  // Connection info
  const connColor = state.connected ? '\x1b[32m' : '\x1b[31m';
  const connText  = state.connected ? 'CONNECTED' : 'WAITING';
  lines.push(`  Target:  \x1b[33m${DRONE_IP}:${CONTROL_PORT}\x1b[0m    Status: ${connColor}${connText}\x1b[0m`);
  lines.push(`  Armed:   ${state.armed ? '\x1b[32mYES\x1b[0m' : '\x1b[90mNO\x1b[0m'}    Packets Sent: \x1b[33m${state.packetsSent}\x1b[0m`);
  lines.push('');

  // Axis values
  lines.push('\x1b[1;37m  ΓöÇΓöÇ AXES ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ\x1b[0m');
  lines.push(`  Roll     [A Γùä Γû║ D]   ${bar(state.roll)}  ${pad(state.roll)}`);
  lines.push(`  Pitch    [W Γû▓ Γû╝ S]   ${bar(state.pitch)}  ${pad(state.pitch)}`);
  lines.push(`  Yaw      [Q Γå║ Γå╗ E]   ${bar(state.yaw)}  ${pad(state.yaw)}`);
  lines.push(`  Throttle [Γû▓Spc Γû╝Sh]  ${bar(state.throttle)}  ${pad(state.throttle)}`);
  lines.push('');

  // Current packet hex
  const pkt = buildControlPacket();
  const pktHex = [...pkt].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  lines.push(`  Sending:  \x1b[90m${pktHex}\x1b[0m`);
  lines.push('');

  // Received packets
  lines.push('\x1b[1;37m  ΓöÇΓöÇ RECEIVED (last 3) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ\x1b[0m');
  if (state.received.length === 0) {
    lines.push('  \x1b[90m  (none)\x1b[0m');
  } else {
    for (const r of state.received) {
      const truncHex = r.hex.length > 80 ? r.hex.substring(0, 80) + 'ΓÇª' : r.hex;
      lines.push(`  \x1b[90m${r.time}\x1b[0m  \x1b[33m${r.from}\x1b[0m  \x1b[36m${r.size}B\x1b[0m`);
      lines.push(`    ${truncHex}`);
    }
  }
  lines.push('');

  // Controls reference
  lines.push('\x1b[1;37m  ΓöÇΓöÇ CONTROLS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ\x1b[0m');
  lines.push('  \x1b[33mW/S\x1b[0m Pitch   \x1b[33mA/D\x1b[0m Roll   \x1b[33mQ/E\x1b[0m Yaw');
  lines.push('  \x1b[33mSpace\x1b[0m Throttle Γû▓   \x1b[33mShift\x1b[0m Throttle Γû╝');
  lines.push('  \x1b[32mT\x1b[0m Takeoff   \x1b[32mL\x1b[0m Land   \x1b[32mV\x1b[0m Video Handshake');
  lines.push('  \x1b[31mESC\x1b[0m Emergency Stop   \x1b[31mCtrl+C\x1b[0m Quit');

  process.stdout.write(lines.join('\n'));
}

function pad(v) {
  const dec = v.toString().padStart(3, ' ');
  const hex = '0x' + v.toString(16).toUpperCase().padStart(2, '0');
  return `\x1b[37m${dec}\x1b[90m (${hex})\x1b[0m`;
}

// ========================== DISCOVERY MODE =================================

function runDiscovery() {
  return new Promise((resolve) => {
    console.log('\x1b[2J\x1b[H');
    console.log('\x1b[1;36m  ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ\x1b[0m');
    console.log('\x1b[1;37m   ≡ƒöì  DISCOVERY MODE\x1b[0m');
    console.log('\x1b[1;36m  ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ\x1b[0m');
    console.log('');
    console.log(`  Listening on UDP port ${CONTROL_PORT} for ${DISCOVERY_TIME / 1000}s...`);
    console.log(`  Target drone IP: ${DRONE_IP}`);
    console.log('');

    // Send video handshake to provoke a response
    sendVideoHandshake();

    // Also send a neutral control packet to see if drone responds
    state.roll = CENTER; state.pitch = CENTER; state.yaw = CENTER; state.throttle = CENTER;
    sendControl();

    const discoveryInterval = setInterval(() => {
      // Periodically poke the drone
      sendVideoHandshake();
      sendControl();
    }, 1000);

    setTimeout(() => {
      clearInterval(discoveryInterval);
      state.discoveryDone = true;

      console.log('\x1b[1;33m  ΓöÇΓöÇ DISCOVERY RESULTS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ\x1b[0m');
      console.log('');

      if (state.discoveryPackets.size === 0) {
        console.log('  \x1b[31m  No packets received from drone.\x1b[0m');
        console.log('  \x1b[90m  Make sure you are connected to the drone\'s WiFi.\x1b[0m');
        console.log('  \x1b[90m  The drone IP might be different from ' + DRONE_IP + '\x1b[0m');
      } else {
        console.log(`  \x1b[32m  ${state.discoveryPackets.size} unique packet(s) received:\x1b[0m`);
        console.log('');
        let i = 0;
        for (const [hex, count] of state.discoveryPackets) {
          const truncHex = hex.length > 100 ? hex.substring(0, 100) + 'ΓÇª' : hex;
          console.log(`  \x1b[36m  [${++i}]\x1b[0m (├ù${count}) ${truncHex}`);
        }
      }

      console.log('');
      console.log('\x1b[1;32m  Γ£ô Discovery complete ΓÇö flight controls active in 2s\x1b[0m');
      console.log('');

      setTimeout(resolve, 2000);
    }, DISCOVERY_TIME);
  });
}

// ========================== MAIN ===========================================

async function main() {
  console.log('');
  console.log('\x1b[1;37m  Drone Controller starting...\x1b[0m');
  console.log(`  Target: ${DRONE_IP}:${CONTROL_PORT}`);
  console.log('');

  setupKeyboard();

  // Phase 1: Discovery
  await runDiscovery();

  // Phase 2: Flight control loop
  // Send control packets at fixed interval
  setInterval(() => {
    updateAxes();
    sendControl();
  }, CONTROL_INTERVAL);

  // HUD refresh (slower than control loop to reduce flicker)
  setInterval(drawHUD, 200);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
