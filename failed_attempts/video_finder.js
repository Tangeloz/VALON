/*
 * 🎥 VIDEO STREAM FINDER
 *
 * PROBLEM: RTSP OPTIONS works on 7070 but ALL paths return 404.
 * VLC can't open the MRL because there's no valid stream path.
 *
 * POSSIBLE EXPLANATIONS:
 *   1. Video is raw TCP (connect → drone pushes H264/MJPEG frames)
 *   2. Video only starts AFTER command port 5007 is activated
 *   3. RTSP path is something very unusual we haven't tried
 *   4. Video is on a different port entirely
 *
 * THIS SCRIPT TESTS ALL THEORIES:
 *   Test A: Activate 5007 first, THEN try raw TCP read on 7070
 *   Test B: Activate 5007 first, THEN try 50+ RTSP paths
 *   Test C: Try raw TCP read on nearby ports (7071-7079, 8080, 8554, etc.)
 *   Test D: Try HTTP MJPEG paths on 7070
 */

const net = require('net');

const DRONE = '192.168.1.1';
const CMD_PORT = 5007;
const VIDEO_PORT = 7070;

function ts() { return new Date().toLocaleTimeString(); }

// ─── Keep command port alive in background ───────────────
let cmdSock = null;
let cmdAlive = false;

function activateCommandPort() {
  return new Promise((resolve) => {
    cmdSock = new net.Socket();
    cmdSock.setNoDelay(true);
    cmdSock.setTimeout(0);

    cmdSock.on('connect', () => {
      cmdAlive = true;
      console.log(`  [${ts()}] ✅ Command port 5007 connected`);

      // Send init
      cmdSock.write(Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));

      // Keep sending heartbeat
      setInterval(() => {
        if (cmdAlive) {
          try {
            cmdSock.write(Buffer.from([0xA0, 0x00, 0x80, 0x80, 0x80, 0x00, 0x00, 0x00]));
          } catch(e) {}
        }
      }, 50);

      // Give the drone a moment to "wake up" with the command channel
      setTimeout(resolve, 1000);
    });

    cmdSock.on('data', (data) => {
      if (data[0] === 0xA1) {
        if (!cmdAlive) console.log(`  [${ts()}] 🎉 Drone acknowledged on 5007!`);
        cmdAlive = true;
      }
    });

    cmdSock.on('close', () => { cmdAlive = false; });
    cmdSock.on('error', () => { cmdAlive = false; resolve(); });

    cmdSock.connect(CMD_PORT, DRONE);
  });
}

// ─── Test A: Raw TCP read on 7070 ────────────────────────
function testRawTcp(port, durationSec) {
  return new Promise((resolve) => {
    console.log(`\n  [Test A] Raw TCP connect to port ${port} — listening ${durationSec}s...`);

    const sock = new net.Socket();
    sock.setTimeout(durationSec * 1000);
    let totalBytes = 0;
    let firstBytes = null;

    sock.on('connect', () => {
      console.log(`  ✅ Connected to ${port}. Waiting for data...`);
    });

    sock.on('data', (data) => {
      totalBytes += data.length;
      if (!firstBytes) {
        firstBytes = data.slice(0, 64);
        console.log(`\n  📨 DATA RECEIVED on port ${port}!`);
        console.log(`  First 64 bytes HEX: ${firstBytes.toString('hex')}`);

        // Detect format
        if (data[0] === 0xFF && data[1] === 0xD8) {
          console.log(`  FORMAT: MJPEG (JPEG frame start detected!)`);
        } else if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x01) {
          console.log(`  FORMAT: H264 NAL unit detected!`);
        } else if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01) {
          console.log(`  FORMAT: H264 short start code detected!`);
        } else if (data.toString('ascii').substring(0, 4) === 'RTSP') {
          console.log(`  FORMAT: RTSP response`);
        } else if (data.toString('ascii').substring(0, 4) === 'HTTP') {
          console.log(`  FORMAT: HTTP response`);
        } else {
          console.log(`  FORMAT: Unknown binary — could be raw video with custom header`);
        }
      }

      if (totalBytes % 10000 < data.length) {
        process.stdout.write(`\r  Received ${totalBytes} bytes so far...   `);
      }
    });

    sock.on('timeout', () => {
      if (totalBytes === 0) {
        console.log(`  Silence on port ${port} after ${durationSec}s.`);
      } else {
        console.log(`\n  Total received: ${totalBytes} bytes`);
      }
      sock.destroy();
      resolve({ port, totalBytes, firstBytes });
    });

    sock.on('error', (err) => {
      console.log(`  Error on port ${port}: ${err.message}`);
      resolve({ port, totalBytes: 0, firstBytes: null });
    });

    sock.on('close', () => {
      if (totalBytes > 0) {
        console.log(`\n  Connection closed. Total: ${totalBytes} bytes`);
      }
      resolve({ port, totalBytes, firstBytes });
    });

    sock.connect(port, DRONE);
  });
}

// ─── Test B: Exhaustive RTSP path search ─────────────────
function testRtspPaths() {
  return new Promise((resolve) => {
    console.log(`\n  [Test B] Exhaustive RTSP DESCRIBE on port ${VIDEO_PORT}...`);

    const paths = [
      // Standard
      '/', '/live', '/stream', '/video', '/cam', '/h264', '/mjpeg',
      // Channel variants
      '/ch0', '/ch1', '/0', '/1', '/ch00_0', '/ch01_0',
      '/live/ch00_0', '/live/ch01_0', '/live/ch0', '/live/ch1',
      // Media variants
      '/media', '/media/video1', '/media/video2',
      '/livestream', '/av0_0', '/11', '/12',
      // ONVIF
      '/onvif1', '/onvif/profile1', '/onvif/device_service',
      // Specific camera paths
      '/PSIA/streaming/channels/1',
      '/streaming/channels/1/httppreview',
      '/videoMain', '/videoSub', '/video1', '/video2',
      // User auth style
      '/user=admin&password=&channel=1&stream=0.sdp',
      '/user=admin&password=admin&channel=1&stream=0',
      // Hikvision/Dahua style
      '/Streaming/Channels/101',
      '/cam/realmonitor?channel=1&subtype=0',
      // Simple variants
      '/main', '/sub', '/live/0', '/live/1',
      '/live.sdp', '/stream.sdp', '/media.sdp',
      '/play1.sdp', '/play2.sdp',
      // Empty / wildcard
      '/*', '',
      // More unusual
      '/tcp/av0_0', '/udp/av0_0',
      '/track1', '/trackID=0', '/trackID=1',
      '/live/main', '/live/sub', '/h264/main', '/h264/sub',
    ];

    const sock = new net.Socket();
    sock.setTimeout(15000);

    let cseq = 1;
    let idx = 0;
    let found = null;
    let buf = '';

    sock.on('connect', () => {
      console.log(`  Connected to RTSP server. Testing ${paths.length} paths...\n`);
      sendNext();
    });

    function sendNext() {
      if (idx >= paths.length || found) {
        if (!found) console.log(`\n  ❌ No valid RTSP path found in ${paths.length} attempts.`);
        sock.destroy();
        resolve(found);
        return;
      }

      const path = paths[idx++];
      const url = `rtsp://${DRONE}:${VIDEO_PORT}${path}`;
      const msg = `DESCRIBE ${url} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAccept: application/sdp\r\n\r\n`;
      sock.write(msg);
    }

    sock.on('data', (data) => {
      buf += data.toString();

      while (buf.includes('\r\n\r\n')) {
        const endIdx = buf.indexOf('\r\n\r\n') + 4;
        const response = buf.substring(0, endIdx);
        buf = buf.substring(endIdx);

        const statusMatch = response.match(/RTSP\/1\.0\s+(\d+)/);
        const code = statusMatch ? parseInt(statusMatch[1]) : 0;
        const path = paths[idx - 1] || '?';

        if (code === 200) {
          found = path;
          console.log(`  🎉 FOUND VALID PATH: ${path}`);
          console.log(`  Full response:`);
          response.split('\r\n').forEach(line => {
            if (line.trim()) console.log(`     ${line}`);
          });
        } else {
          if (idx % 10 === 0) {
            process.stdout.write(`\r  Tested ${idx}/${paths.length} paths... (all ${code} so far)   `);
          }
        }

        sendNext();
      }
    });

    sock.on('error', (err) => {
      console.log(`  RTSP error: ${err.message}`);
      resolve(null);
    });

    sock.on('timeout', () => {
      console.log(`  RTSP timeout.`);
      sock.destroy();
      resolve(null);
    });

    sock.connect(VIDEO_PORT, DRONE);
  });
}

// ─── Test C: Scan nearby ports for raw video ─────────────
function testNearbyPorts() {
  return new Promise((resolve) => {
    console.log(`\n  [Test C] Quick raw TCP test on nearby video ports...`);

    const ports = [7071, 7072, 7073, 7074, 7075, 7076, 7077, 7078, 7079, 7080,
                   8080, 8081, 8554, 554, 80, 5008, 5009, 5010, 5006, 5005, 8000, 8888, 9090];

    let results = [];
    let idx = 0;

    function tryNext() {
      if (idx >= ports.length) {
        const hits = results.filter(r => r.totalBytes > 0);
        if (hits.length > 0) {
          console.log(`\n  Found data on ports: ${hits.map(h => `${h.port}(${h.totalBytes}B)`).join(', ')}`);
        } else {
          console.log(`\n  No data received on any nearby port.`);
        }
        resolve(hits);
        return;
      }

      const port = ports[idx++];
      const s = new net.Socket();
      s.setTimeout(2000);
      let bytes = 0;
      let first = null;

      s.on('connect', () => { /* just wait */ });
      s.on('data', (data) => {
        bytes += data.length;
        if (!first) {
          first = data.slice(0, 16);
          console.log(`  📨 Port ${port}: ${data.length}B — ${first.toString('hex')}`);
        }
      });
      s.on('timeout', () => s.destroy());
      s.on('error', () => {});
      s.on('close', () => {
        if (bytes === 0) process.stdout.write(`  ${port}:silent `);
        results.push({ port, totalBytes: bytes, firstBytes: first });
        tryNext();
      });

      s.connect(port, DRONE);
    }

    tryNext();
  });
}

// ─── Test D: HTTP MJPEG on 7070 ──────────────────────────
function testHttpMjpeg() {
  return new Promise((resolve) => {
    console.log(`\n\n  [Test D] HTTP MJPEG/snapshot paths on port ${VIDEO_PORT}...`);

    const httpPaths = [
      'GET / HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
      'GET /mjpeg HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
      'GET /video HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
      'GET /stream HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
      'GET /snapshot HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
      'GET /live HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
      'GET /cgi-bin/video.cgi HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
      'GET /?action=stream HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
      'GET /?action=snapshot HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n',
    ];

    let idx = 0;
    let found = null;

    function tryNext() {
      if (idx >= httpPaths.length || found) {
        resolve(found);
        return;
      }

      const req = httpPaths[idx++];
      const pathMatch = req.match(/GET\s+(\S+)/);
      const path = pathMatch ? pathMatch[1] : '?';

      const s = new net.Socket();
      s.setTimeout(3000);
      let buf = Buffer.alloc(0);

      s.on('connect', () => {
        process.stdout.write(`  HTTP ${path} ... `);
        s.write(req);
      });

      s.on('data', (data) => {
        buf = Buffer.concat([buf, data]);
      });

      s.on('timeout', () => s.destroy());
      s.on('error', () => {});
      s.on('close', () => {
        if (buf.length > 0) {
          const str = buf.toString('ascii').substring(0, 200);
          if (str.includes('200 OK') || str.includes('200 ok')) {
            found = path;
            console.log(`REPLIED!`);
            console.log(`     ${str.replace(/\r\n/g, ' | ').substring(0, 150)}`);
          } else if (str.includes('RTSP')) {
            console.log(`got RTSP response (not HTTP)`);
          } else {
            console.log(`${buf.length}B — not HTTP`);
          }
        } else {
          console.log(`silent`);
        }
        setTimeout(tryNext, 200);
      });

      s.connect(VIDEO_PORT, DRONE);
    }

    tryNext();
  });
}

// ─── Test E: Send video start command on 5007 then read 7070 ──
function testVideoActivation() {
  return new Promise((resolve) => {
    console.log(`\n\n  [Test E] Try "video start" commands on 5007, then read 7070...`);

    // These might be video-start commands for Syma-like drones
    const videoStartCmds = [
      Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00]), // flag 0x40 = video?
      Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00]), // flag 0x80 = video?
      Buffer.from([0xA0, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // byte1 = 1 = start?
      Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]), // byte6 = 1 = video?
      Buffer.from([0xA0, 0xFF, 0x80, 0x80, 0x80, 0x00, 0x00, 0x00]), // full throttle + center sticks
    ];

    let idx = 0;

    function tryNextVideoCmd() {
      if (idx >= videoStartCmds.length) {
        resolve();
        return;
      }

      const cmd = videoStartCmds[idx++];
      console.log(`\n  Sending video cmd: ${cmd.toString('hex')}`);

      // Send to command port
      if (cmdSock && cmdAlive) {
        cmdSock.write(cmd);
      }

      // Wait a moment, then try to read video
      setTimeout(() => {
        const vidSock = new net.Socket();
        vidSock.setTimeout(3000);
        let gotData = false;

        vidSock.on('connect', () => {
          process.stdout.write(`  Listening on 7070... `);
        });

        vidSock.on('data', (data) => {
          gotData = true;
          console.log(`\n  📨 VIDEO DATA after cmd ${cmd.toString('hex')}!`);
          console.log(`  ${data.length} bytes — HEX: ${data.toString('hex').substring(0, 64)}`);

          if (data[0] === 0xFF && data[1] === 0xD8) console.log(`  FORMAT: MJPEG!`);
          else if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x01) console.log(`  FORMAT: H264!`);
        });

        vidSock.on('timeout', () => {
          if (!gotData) process.stdout.write(`silent\n`);
          vidSock.destroy();
          tryNextVideoCmd();
        });

        vidSock.on('error', () => {
          tryNextVideoCmd();
        });

        vidSock.connect(VIDEO_PORT, DRONE);
      }, 500);
    }

    tryNextVideoCmd();
  });
}

// ─── MAIN ────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  🎥 VIDEO STREAM FINDER                              ║');
  console.log('║  Port 7070 has RTSP but all paths 404               ║');
  console.log('║  Finding the REAL way to get video...                ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Test A: Raw TCP read on 7070 (after 5007 active)   ║');
  console.log('║  Test B: 50+ RTSP paths on 7070                     ║');
  console.log('║  Test C: Raw TCP on nearby ports                     ║');
  console.log('║  Test D: HTTP MJPEG paths on 7070                    ║');
  console.log('║  Test E: Video start commands on 5007 → read 7070    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // First: activate command port (drone may require this for video)
  console.log('  Step 0: Activating command port 5007 first...');
  await activateCommandPort();

  // Test A: Raw TCP on 7070
  await testRawTcp(VIDEO_PORT, 5);

  // Test B: RTSP paths
  const rtspPath = await testRtspPaths();

  // Test C: Nearby ports
  await testNearbyPorts();

  // Test D: HTTP MJPEG
  await testHttpMjpeg();

  // Test E: Video activation commands
  await testVideoActivation();

  // ─── Summary ──────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(56));
  console.log('  📊 VIDEO FINDER RESULTS');
  console.log('═'.repeat(56));
  if (rtspPath) {
    console.log(`  ✅ RTSP Path found: ${rtspPath}`);
    console.log(`  VLC URL: rtsp://${DRONE}:${VIDEO_PORT}${rtspPath}`);
  } else {
    console.log(`  ❌ No RTSP path found.`);
    console.log(`  Check above for any 📨 DATA results — those reveal the format.`);
  }
  console.log('═'.repeat(56));

  // Cleanup
  if (cmdSock) cmdSock.destroy();
  process.exit();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
