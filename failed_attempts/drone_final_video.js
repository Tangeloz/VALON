const net = require('net');
const dgram = require('dgram');

const DRONE = '192.168.1.1';
const VIDEO_PORT_TCP = 7070;
const VIDEO_PORT_UDP = 8800;

function ts() { return new Date().toLocaleTimeString(); }

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  🎥 DRONE VIDEO STREAM v3.0 — RTSP SETUP BYPASS         ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ─── Method 1: UDP 8800 (Standard E58) ───────────────────
const udpSock = dgram.createSocket('udp4');
let udpPackets = 0;

udpSock.on('message', (msg) => {
  udpPackets++;
  if (udpPackets === 1) {
    console.log(`\n  [${ts()}] 🎉 BINGO! Receiving video data on UDP 8800!`);
    console.log(`  Use video_stream_v2.js logic to save frames.`);
  }
});

udpSock.bind(0, () => {
  // Send video start command to UDP 8800
  const cmd = Buffer.from([0xEF, 0x00, 0x04, 0x00]);
  setInterval(() => {
    udpSock.send(cmd, 0, cmd.length, VIDEO_PORT_UDP, DRONE);
  }, 2000);
});

// ─── Method 2: RTSP SETUP Bypass on TCP 7070 ─────────────
const tcpSock = new net.Socket();
tcpSock.setTimeout(5000);

let cseq = 1;

tcpSock.on('connect', () => {
  console.log(`  [${ts()}] Connected to TCP 7070 RTSP.`);
  console.log(`  [${ts()}] Bypassing DESCRIBE, sending SETUP directly...`);
  
  const setupCmd = `SETUP rtsp://${DRONE}:${VIDEO_PORT_TCP}/ RTSP/1.0\r\nCSeq: ${cseq++}\r\nTransport: RTP/AVP;unicast;client_port=8000-8001\r\n\r\n`;
  tcpSock.write(setupCmd);
});

tcpSock.on('data', (data) => {
  const text = data.toString('ascii');
  console.log(`\n  <- RTSP REPLY:\n${text.split('\n').map(l => '    ' + l).join('\n')}`);
  
  if (text.includes('200 OK') && text.includes('Session:')) {
    // Extract session ID
    const match = text.match(/Session:\s*([^\r\n;]+)/i);
    if (match) {
      const sessionId = match[1];
      console.log(`  [${ts()}] 🚀 Got Session ID: ${sessionId}`);
      console.log(`  [${ts()}] Sending PLAY command...`);
      
      const playCmd = `PLAY rtsp://${DRONE}:${VIDEO_PORT_TCP}/ RTSP/1.0\r\nCSeq: ${cseq++}\r\nSession: ${sessionId}\r\n\r\n`;
      tcpSock.write(playCmd);
    }
  } else if (text.includes('404 Not Found')) {
    console.log(`  [${ts()}] ❌ SETUP returned 404. RTSP requires a specific path.`);
    // Try one more path
    const setupCmd2 = `SETUP rtsp://${DRONE}:${VIDEO_PORT_TCP}/live RTSP/1.0\r\nCSeq: ${cseq++}\r\nTransport: RTP/AVP;unicast;client_port=8000-8001\r\n\r\n`;
    tcpSock.write(setupCmd2);
  }
});

tcpSock.on('close', () => {
  console.log(`  [${ts()}] TCP 7070 closed. Listening for UDP video...`);
});
tcpSock.on('error', () => {});

tcpSock.connect(VIDEO_PORT_TCP, DRONE);
