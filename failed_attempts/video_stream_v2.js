/*
 * 🎥 VIDEO STREAM v2.0 — REAL E58 UDP VIDEO PROTOCOL
 *
 * The video is NOT RTSP on port 7070.
 * The real video protocol uses UDP port 8800:
 *   1. Send  EF 00 04 00  to UDP 8800 → triggers video
 *   2. Drone sends back UDP packets: 56-byte header + JPEG fragment
 *   3. Reassemble fragments into JPEG frames
 *   4. Save frames as images or pipe to viewer
 *
 * This script:
 *   - Sends heartbeat to UDP 40000 (required to keep drone alive)
 *   - Sends video start to UDP 8800
 *   - Listens for video packets
 *   - Reassembles JPEG frames and saves them
 */

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const DRONE = '192.168.1.1';
const HEARTBEAT_PORT = 40000;
const VIDEO_PORT = 8800;
const CONTROL_PORT = 50000;

const OUTPUT_DIR = path.join(__dirname, 'drone_frames');

function ts() { return new Date().toLocaleTimeString(); }

// ─── UDP socket ──────────────────────────────────────────
const sock = dgram.createSocket('udp4');

let totalPackets = 0;
let totalBytes = 0;
let framesAssembled = 0;
let currentFrame = [];
let lastFrameId = -1;

// Video packet header is 56 bytes for E58 protocol
const HEADER_SIZE = 56;

// Create output directory
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

sock.on('message', (msg, rinfo) => {
  totalPackets++;
  totalBytes += msg.length;

  // First packet ever?
  if (totalPackets === 1) {
    console.log(`\n  🎉 FIRST VIDEO PACKET RECEIVED!`);
    console.log(`  From: ${rinfo.address}:${rinfo.port}`);
    console.log(`  Size: ${msg.length} bytes`);
    console.log(`  First 32 bytes HEX: ${msg.toString('hex').substring(0, 64)}`);
    console.log(`  Looking for JPEG markers (FFD8 = start, FFD9 = end)...`);

    // Analyze content
    for (let i = 0; i < msg.length - 1; i++) {
      if (msg[i] === 0xFF && msg[i + 1] === 0xD8) {
        console.log(`  ✅ JPEG start marker found at offset ${i}!`);
      }
      if (msg[i] === 0xFF && msg[i + 1] === 0xD9) {
        console.log(`  ✅ JPEG end marker found at offset ${i}!`);
      }
    }
  }

  // Try to detect JPEG frames in raw data
  // Method 1: Look for JPEG markers directly
  for (let i = 0; i < msg.length - 1; i++) {
    if (msg[i] === 0xFF && msg[i + 1] === 0xD8) {
      // Start of new JPEG frame
      if (currentFrame.length > 0) {
        // Save previous frame
        saveFrame(Buffer.concat(currentFrame));
      }
      currentFrame = [msg.slice(i)];
      return;
    }
  }

  // If we're in the middle of a frame, append data
  if (currentFrame.length > 0) {
    currentFrame.push(msg);

    // Check if this packet contains JPEG end marker
    for (let i = 0; i < msg.length - 1; i++) {
      if (msg[i] === 0xFF && msg[i + 1] === 0xD9) {
        // End of JPEG frame
        saveFrame(Buffer.concat(currentFrame));
        currentFrame = [];
        return;
      }
    }
  }

  // Method 2: If header is 56 bytes, strip it and look for JPEG data
  if (msg.length > HEADER_SIZE) {
    const payload = msg.slice(HEADER_SIZE);
    if (payload[0] === 0xFF && payload[1] === 0xD8) {
      console.log(`  [${ts()}] Found JPEG after 56-byte header!`);
      currentFrame = [payload];
    }
  }

  // Status update every 100 packets
  if (totalPackets % 100 === 0) {
    process.stdout.write(`\r  Packets: ${totalPackets}  Bytes: ${(totalBytes/1024).toFixed(0)}KB  Frames: ${framesAssembled}   `);
  }
});

function saveFrame(buf) {
  framesAssembled++;

  // Only save first 10 frames to avoid filling disk
  if (framesAssembled <= 10) {
    const filename = path.join(OUTPUT_DIR, `frame_${String(framesAssembled).padStart(4, '0')}.jpg`);
    fs.writeFileSync(filename, buf);
    console.log(`\n  📸 Saved frame ${framesAssembled}: ${filename} (${buf.length} bytes)`);
  } else if (framesAssembled === 11) {
    console.log(`\n  📸 (Stopped saving after 10 frames. Video is working!)`);
  }
}

sock.on('error', (err) => {
  console.log(`  Socket error: ${err.message}`);
});

// ─── Send heartbeat to keep drone alive ──────────────────
function startHeartbeat() {
  const hb = Buffer.from([0x63, 0x63, 0x01, 0x00, 0x00, 0x00, 0x00]);
  setInterval(() => {
    sock.send(hb, 0, hb.length, HEARTBEAT_PORT, DRONE);
  }, 1000);
  sock.send(hb, 0, hb.length, HEARTBEAT_PORT, DRONE);
}

// ─── Send control packets (needed to keep drone responsive) ──
function startMinimalControl() {
  // Send neutral stick positions
  const neutral = Buffer.from([0x66, 0x80, 0x80, 0x00, 0x80, 0x00, 0x00, 0x99]);
  // Fix checksum: XOR of bytes 1-4
  neutral[6] = (neutral[1] ^ neutral[2] ^ neutral[3] ^ neutral[4]) & 0xFF;

  setInterval(() => {
    sock.send(neutral, 0, neutral.length, CONTROL_PORT, DRONE);
  }, 50);
}

// ─── Request video stream ────────────────────────────────
function requestVideo() {
  const cmd = Buffer.from([0xEF, 0x00, 0x04, 0x00]);
  sock.send(cmd, 0, cmd.length, VIDEO_PORT, DRONE);
  console.log(`  [${ts()}] Video start command sent → UDP ${VIDEO_PORT}`);

  // Re-send every 2 seconds in case it needs repeated
  setInterval(() => {
    sock.send(cmd, 0, cmd.length, VIDEO_PORT, DRONE);
  }, 2000);
}

// ─── MAIN ────────────────────────────────────────────────
function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🎥 VIDEO STREAM v2.0 — REAL E58 UDP PROTOCOL           ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Heartbeat → UDP 40000 (keep drone alive)               ║');
  console.log('║  Control   → UDP 50000 (neutral sticks)                  ║');
  console.log('║  Video cmd → UDP 8800  (EF 00 04 00)                     ║');
  console.log('║  Listen    → UDP 8800  (JPEG fragments)                  ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Frames saved to: ${OUTPUT_DIR.substring(0,39).padEnd(39)}║`);
  console.log('║  Press Ctrl+C to stop                                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log('  ⚠️  Make sure Windows Firewall is OFF (or network is Private)!\n');

  sock.bind(0, () => {
    const localPort = sock.address().port;
    console.log(`  [${ts()}] Listening on UDP port ${localPort}`);

    startHeartbeat();
    startMinimalControl();
    requestVideo();

    console.log(`  [${ts()}] All systems running. Waiting for video data...\n`);
    console.log('  (If nothing after 15s: Firewall OFF? Connected to drone WiFi?)\n');

    // Timeout check
    setTimeout(() => {
      if (totalPackets === 0) {
        console.log('\n  ⚠️ No video packets received after 15 seconds.');
        console.log('  Possible causes:');
        console.log('    1. Windows Firewall is blocking UDP');
        console.log('    2. Not connected to drone WiFi');
        console.log('    3. Drone firmware variant uses different ports');
        console.log('\n  Trying alternate video ports...');

        // Try other common video ports
        const altPorts = [7060, 8080, 9090, 8888, 554, 5000, 7070, 5007];
        const cmd = Buffer.from([0xEF, 0x00, 0x04, 0x00]);
        altPorts.forEach(p => {
          sock.send(cmd, 0, cmd.length, p, DRONE);
          console.log(`    Video start → UDP ${p}`);
        });
      }
    }, 15000);
  });
}

main();
