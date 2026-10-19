/*
 * DRONE CONNECTOR v1
 *
 * ✅ CONFIRMED:
 *   Port 7070 = RTSP video server (DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN)
 *   Port 5007 = Command port (custom binary — NOT HTTP, NOT RTSP)
 *
 * PLAN:
 *   1. Establish full RTSP session on 7070 (DESCRIBE → SETUP → PLAY)
 *   2. While video is "playing", probe port 5007 for commands
 *      Theory: drone may only accept flight commands while video is active
 *   3. Try every known command protocol on 5007
 */

const net = require('net');
const dgram = require('dgram');

const DRONE = '192.168.1.1';
const VIDEO_PORT = 7070;
const CMD_PORT = 5007;

function ts() { return new Date().toLocaleTimeString(); }

// ═══════════════════════════════════════════════════════════════
//  STEP 1: Full RTSP handshake on port 7070
//  DESCRIBE → SETUP → PLAY
// ═══════════════════════════════════════════════════════════════
function establishRTSP() {
  return new Promise((resolve, reject) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  STEP 1: ESTABLISH RTSP VIDEO SESSION on 7070            ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const sock = new net.Socket();
    sock.setTimeout(10000);

    let cseq = 1;
    let state = 'DESCRIBE';  // → SETUP → PLAY → DONE
    let sessionId = null;
    let streamPath = '/';
    let buf = '';

    // Common RTSP paths for cheap drones
    const PATHS_TO_TRY = ['/', '/live', '/stream', '/video', '/cam', '/h264', '/mjpeg', '/ch0', '/0', '/1', '/livestream', '/av0_0', '/11', '/media'];
    let pathIdx = 0;

    sock.on('connect', () => {
      console.log(`  ✅ Connected to RTSP server (${VIDEO_PORT})`);
      sendDescribe();
    });

    function sendDescribe() {
      streamPath = PATHS_TO_TRY[pathIdx] || '/';
      const msg = `DESCRIBE rtsp://${DRONE}:${VIDEO_PORT}${streamPath} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAccept: application/sdp\r\n\r\n`;
      console.log(`  → DESCRIBE ${streamPath}`);
      sock.write(msg);
    }

    sock.on('data', (data) => {
      buf += data.toString();

      // Check if we have a complete response (ends with \r\n\r\n)
      if (!buf.includes('\r\n\r\n')) return;

      const response = buf;
      buf = '';

      // Parse status code
      const statusMatch = response.match(/RTSP\/1\.0\s+(\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;

      if (state === 'DESCRIBE') {
        console.log(`\n  ← DESCRIBE response (${statusCode}):`);
        // Print the full response for analysis
        response.split('\r\n').forEach(line => {
          if (line.trim()) console.log(`     ${line}`);
        });

        if (statusCode === 200) {
          // Extract session ID if present
          const sessMatch = response.match(/Session:\s*(\S+)/);
          if (sessMatch) sessionId = sessMatch[1].split(';')[0];

          // Extract track/control URL from SDP
          const controlMatch = response.match(/a=control:\s*(\S+)/);
          const trackUrl = controlMatch ? controlMatch[1] : `rtsp://${DRONE}:${VIDEO_PORT}${streamPath}`;

          console.log(`\n  Session: ${sessionId || 'none'}`);
          console.log(`  Track: ${trackUrl}`);

          // Move to SETUP
          state = 'SETUP';
          const setupUrl = trackUrl.startsWith('rtsp://') ? trackUrl : `rtsp://${DRONE}:${VIDEO_PORT}${streamPath}/${trackUrl}`;
          const setupMsg = `SETUP ${setupUrl} RTSP/1.0\r\nCSeq: ${cseq++}\r\nTransport: RTP/AVP;unicast;client_port=5600-5601\r\n${sessionId ? 'Session: ' + sessionId + '\r\n' : ''}\r\n`;
          console.log(`\n  → SETUP ${setupUrl}`);
          sock.write(setupMsg);

        } else if (statusCode === 404 || statusCode === 451 || statusCode === 400) {
          // Try next path
          pathIdx++;
          if (pathIdx < PATHS_TO_TRY.length) {
            console.log(`  (Path ${streamPath} not found, trying next...)`);
            sendDescribe();
          } else {
            console.log(`  ❌ No valid RTSP path found after trying all options.`);
            // Still try SETUP on root
            state = 'SETUP';
            const setupMsg = `SETUP rtsp://${DRONE}:${VIDEO_PORT}/ RTSP/1.0\r\nCSeq: ${cseq++}\r\nTransport: RTP/AVP;unicast;client_port=5600-5601\r\n\r\n`;
            console.log(`\n  → SETUP / (fallback)`);
            sock.write(setupMsg);
          }
        }
      } else if (state === 'SETUP') {
        console.log(`\n  ← SETUP response (${statusCode}):`);
        response.split('\r\n').forEach(line => {
          if (line.trim()) console.log(`     ${line}`);
        });

        // Extract session and transport
        const sessMatch = response.match(/Session:\s*(\S+)/);
        if (sessMatch) sessionId = sessMatch[1].split(';')[0];

        const serverPortMatch = response.match(/server_port=(\d+)-(\d+)/);
        if (serverPortMatch) {
          console.log(`  Server RTP port: ${serverPortMatch[1]}`);
        }

        // Move to PLAY
        state = 'PLAY';
        const playMsg = `PLAY rtsp://${DRONE}:${VIDEO_PORT}${streamPath} RTSP/1.0\r\nCSeq: ${cseq++}\r\n${sessionId ? 'Session: ' + sessionId + '\r\n' : ''}Range: npt=0.000-\r\n\r\n`;
        console.log(`\n  → PLAY`);
        sock.write(playMsg);

      } else if (state === 'PLAY') {
        console.log(`\n  ← PLAY response (${statusCode}):`);
        response.split('\r\n').forEach(line => {
          if (line.trim()) console.log(`     ${line}`);
        });

        if (statusCode === 200) {
          console.log(`\n  🎉 VIDEO SESSION IS LIVE!`);
          console.log(`  RTSP URL: rtsp://${DRONE}:${VIDEO_PORT}${streamPath}`);
          console.log(`  Session ID: ${sessionId}`);
        }

        state = 'DONE';
        resolve({ sock, sessionId, streamPath });
      }
    });

    sock.on('error', (err) => {
      console.log(`  RTSP error: ${err.message}`);
      resolve({ sock: null, sessionId: null, streamPath: '/' });
    });

    sock.on('timeout', () => {
      console.log(`  RTSP timeout in state: ${state}`);
      resolve({ sock, sessionId, streamPath });
    });

    sock.connect(VIDEO_PORT, DRONE);
  });
}

// ═══════════════════════════════════════════════════════════════
//  STEP 2: While RTSP is active, crack port 5007
// ═══════════════════════════════════════════════════════════════
function crackCommandPort(rtspSock) {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  STEP 2: CRACK COMMAND PORT 5007 (while video is live)   ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Exhaustive list of possible init sequences
    const CMD_PROBES = [
      // ── cooingdv protocol variants ──
      { name: 'cooingdv takeoff',    data: Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x01, 0x00, 0x99]) },
      { name: 'cooingdv land',       data: Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x02, 0x00, 0x99]) },
      { name: 'cooingdv center',     data: Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]) },
      { name: 'cooingdv unlock',     data: Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x04, 0x00, 0x99]) },
      { name: 'cooingdv headless',   data: Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x08, 0x00, 0x99]) },
      { name: 'cooingdv alt',        data: Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]) },
      { name: 'cooingdv alt unlock', data: Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x04, 0x00, 0x33]) },

      // ── "connect" commands seen in decompiled APKs ──
      { name: 'EF init',            data: Buffer.from([0xEF, 0x00, 0x04, 0x00]) },
      { name: 'EF connect',         data: Buffer.from([0xEF, 0x01, 0x04, 0x00]) },
      { name: 'EF unlock',          data: Buffer.from([0xEF, 0x02, 0x04, 0x00]) },

      // ── Length-prefixed variants ──
      { name: 'len8 init',          data: Buffer.from([0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
      { name: 'len4 init',          data: Buffer.from([0x04, 0x00, 0x00, 0x00]) },

      // ── Completely different protocol families ──
      { name: 'TELLO connect',      data: Buffer.from('conn_req:\x00\x00'),  },
      { name: 'TELLO alt',          data: Buffer.from([0xcc, 0x58, 0x00, 0x7c, 0x68, 0x25, 0x00, 0x00, 0x00, 0x00, 0x00]) },
      { name: 'WLtoys hello',       data: Buffer.from([0xAB, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
      { name: 'Syma hello',         data: Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
      { name: 'Hubsan hello',       data: Buffer.from([0x0E, 0x0E, 0x0E, 0x0E]) },

      // ── JSON/text commands ──
      { name: 'JSON connect',       data: Buffer.from('{"cmd":"connect"}\n') },
      { name: 'JSON unlock',        data: Buffer.from('{"cmd":"unlock"}\n') },
      { name: 'JSON start',         data: Buffer.from('{"cmd":"start"}\n') },
      { name: 'TEXT connect',       data: Buffer.from('connect\r\n') },
      { name: 'TEXT hello',         data: Buffer.from('hello\r\n') },
      { name: 'TEXT start',         data: Buffer.from('start\r\n') },

      // ── Single/double byte starts ──
      { name: '0x01 cmd',           data: Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
      { name: '0x02 cmd',           data: Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
      { name: '0xFF cmd',           data: Buffer.from([0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
      { name: '0xFE cmd',           data: Buffer.from([0xFE, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },

      // ── KY UFO specific (from app name) ──
      { name: 'KY version',         data: Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x10, 0x00, 0x99]) },
      { name: 'KY calibrate',       data: Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x20, 0x00, 0x99]) },
      { name: 'KY photo',           data: Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x40, 0x00, 0x99]) },
    ];

    let idx = 0;

    function tryNext() {
      if (idx >= CMD_PROBES.length) {
        console.log('\n  All command probes exhausted.');
        resolve(false);
        return;
      }

      const probe = CMD_PROBES[idx++];
      const sock = new net.Socket();
      sock.setTimeout(1000);
      let gotReply = false;

      sock.on('connect', () => {
        process.stdout.write(`  [${probe.name}] → ${probe.data.length}B ... `);
        sock.write(probe.data);
      });

      sock.on('data', (data) => {
        gotReply = true;
        console.log(`\n\n  🎉🎉🎉 PORT 5007 REPLIED TO "${probe.name}"!!! 🎉🎉🎉`);
        console.log(`  SENT:    ${probe.data.toString('hex')}`);
        console.log(`  REPLY:   ${data.toString('hex').substring(0, 120)}`);
        console.log(`  ASCII:   ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 120)}`);
        console.log(`  LENGTH:  ${data.length} bytes`);
        sock.destroy();
        resolve(true);
      });

      sock.on('timeout', () => {
        if (!gotReply) process.stdout.write('silent\n');
        sock.destroy();
      });

      sock.on('error', (err) => {
        if (!gotReply) process.stdout.write(`${err.code || 'error'}\n`);
      });

      sock.on('close', () => {
        if (!gotReply) setTimeout(tryNext, 100);
      });

      sock.connect(CMD_PORT, DRONE);
    }

    tryNext();
  });
}

// ═══════════════════════════════════════════════════════════════
//  STEP 3: Try UDP commands while RTSP + TCP are both alive
// ═══════════════════════════════════════════════════════════════
function tryUdpWhileConnected(rtspSock) {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  STEP 3: UDP WHILE RTSP IS LIVE                          ║');
    console.log('║  Theory: drone unlocks UDP only after RTSP session starts ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Also open a TCP to 5007 to hold it
    const cmdTcp = new net.Socket();
    cmdTcp.setTimeout(30000);
    cmdTcp.on('connect', () => console.log('  ✅ TCP 5007 held open'));
    cmdTcp.on('data', (d) => {
      console.log(`  📨 TCP 5007 DATA: ${d.toString('hex').substring(0, 80)}`);
    });
    cmdTcp.on('error', () => {});
    cmdTcp.connect(CMD_PORT, DRONE);

    const udpSock = dgram.createSocket('udp4');
    const UDP_PROBES = [
      Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
      Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
      Buffer.from([0xEF, 0x00, 0x04, 0x00]),
    ];

    // Focus on ports near our known TCP ports
    const udpPorts = [5007, 7070, 5000, 5008, 5009, 5010, 7060, 7071, 7072,
                      8800, 8080, 40000, 50000, 8888, 9090, 80, 1234, 4567];

    udpSock.on('message', (msg, rinfo) => {
      if (rinfo.address === '127.0.0.1') return;
      console.log(`\n  🎉 UDP REPLY from ${rinfo.address}:${rinfo.port}!`);
      console.log(`  HEX: ${msg.toString('hex').substring(0, 80)}`);
    });

    udpSock.bind(0, () => {
      let i = 0;
      const interval = setInterval(() => {
        if (i >= udpPorts.length) {
          clearInterval(interval);
          console.log('  Waiting 5 seconds for UDP replies...');
          setTimeout(() => {
            udpSock.close();
            try { cmdTcp.destroy(); } catch(e) {}
            resolve();
          }, 5000);
          return;
        }
        const port = udpPorts[i++];
        UDP_PROBES.forEach(p => udpSock.send(p, 0, p.length, port, DRONE));
        process.stdout.write(`\r  UDP → ${DRONE}:${port}   `);
      }, 200);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║  🛸 DRONE CONNECTOR v1                                   ║');
  console.log('║  Port 7070 = RTSP video ✅                                ║');
  console.log('║  Port 5007 = Command port (cracking...)                   ║');
  console.log('╠' + '═'.repeat(58) + '╣');
  console.log('║  Step 1: Establish RTSP video session                     ║');
  console.log('║  Step 2: Crack command port 5007 (while video is live)    ║');
  console.log('║  Step 3: Try UDP while RTSP + TCP are both alive          ║');
  console.log('║                                                           ║');
  console.log('║  ⏱️  ETA: ~3 minutes                                      ║');
  console.log('╚' + '═'.repeat(58) + '╝');

  // Step 1: RTSP
  const { sock: rtspSock, sessionId, streamPath } = await establishRTSP();

  // Step 2: Crack 5007
  const cracked = await crackCommandPort(rtspSock);

  // Step 3: UDP while connected
  if (!cracked) await tryUdpWhileConnected(rtspSock);

  // Cleanup
  if (rtspSock) {
    try {
      const teardown = `TEARDOWN rtsp://${DRONE}:${VIDEO_PORT}${streamPath} RTSP/1.0\r\nCSeq: 99\r\n${sessionId ? 'Session: ' + sessionId + '\r\n' : ''}\r\n`;
      rtspSock.write(teardown);
      setTimeout(() => {
        rtspSock.destroy();
      }, 500);
    } catch(e) {}
  }

  // Final report
  console.log('\n' + '═'.repeat(60));
  console.log('  📊 RESULTS');
  console.log('═'.repeat(60));
  console.log(`  Video: rtsp://${DRONE}:7070${streamPath}`);
  console.log(`  → Open this URL in VLC to see the camera feed!`);
  if (cracked) {
    console.log(`  Command port: CRACKED! See details above.`);
  } else {
    console.log(`  Command port 5007: not cracked yet.`);
    console.log(`  Next step: Wireshark to capture exact KY UFO commands.`);
  }
  console.log('═'.repeat(60));
  process.exit();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
