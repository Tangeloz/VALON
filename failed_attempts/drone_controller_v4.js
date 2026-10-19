/*
 * 🛸 DRONE CONTROLLER v4.0 — TCP PROTOCOL UPGRADE THEORY
 *
 * WHAT ACTUALLY WORKS:
 *   TCP 5007 → 0xA0 gets 0xA1 + "Upgrade_ok"
 *   TCP 7070 → RTSP OPTIONS works
 *   UDP      → NOTHING (this firmware doesn't use UDP)
 *
 * NEW THEORY:
 *   "Upgrade_ok" means PROTOCOL UPGRADE (not firmware upgrade!)
 *   After the upgrade, we must switch from 0xA0 to control packets.
 *   The connection died because we kept sending 0xA0 after upgrade.
 *
 * PLAN:
 *   Phase A: Connect → send ONE 0xA0 → wait for "Upgrade_ok" → switch to control
 *   Phase B: If A works, try RTSP DESCRIBE on 7070 (paths may unlock after 5007 upgrade)
 *   Phase C: Try different post-upgrade packet formats
 */

const net = require('net');
const readline = require('readline');

const DRONE = '192.168.1.1';
const CMD_PORT = 5007;
const VIDEO_PORT = 7070;

function ts() { return new Date().toLocaleTimeString(); }

// ─── Joystick state ──────────────────────────────────────
let roll = 128, pitch = 128, throttle = 0, yaw = 128, cmdBits = 0x00;
let packetsSent = 0, repliesReceived = 0;
let upgraded = false;
let controlFormatIdx = 0; // Which format we're currently testing

// ─── Multiple possible control packet formats ────────────
function buildControlPacket(format) {
  const r = roll & 0xFF, p = pitch & 0xFF, t = throttle & 0xFF, y = yaw & 0xFF;

  switch (format) {
    case 0: // Standard cooingdv: 66 [roll] [pitch] [throt] [yaw] [cmd] [checksum] 99
      return Buffer.from([0x66, r, p, t, y, cmdBits, (r ^ p ^ t ^ y) & 0xFF, 0x99]);

    case 1: // Alt cooingdv: cc [roll] [pitch] [throt] [yaw] [cmd] [checksum] 33
      return Buffer.from([0xCC, r, p, t, y, cmdBits, (r ^ p ^ t ^ y) & 0xFF, 0x33]);

    case 2: // No header/footer, just data
      return Buffer.from([r, p, t, y, cmdBits, (r ^ p ^ t ^ y) & 0xFF]);

    case 3: // With A1 header (drone's own reply header)
      return Buffer.from([0xA1, r, p, t, y, cmdBits, (r ^ p ^ t ^ y) & 0xFF, 0x00]);

    case 4: // With A2 header (next after A1)
      return Buffer.from([0xA2, r, p, t, y, cmdBits, (r ^ p ^ t ^ y) & 0xFF, 0x00]);

    case 5: // 0x66 with 0x80 center (standard format)
      return Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]);

    default:
      return Buffer.from([0x66, r, p, t, y, cmdBits, (r ^ p ^ t ^ y) & 0xFF, 0x99]);
  }
}

const FORMAT_NAMES = [
  '0x66..0x99 (cooingdv)',
  '0xCC..0x33 (alt cooingdv)',
  'raw 6-byte',
  '0xA1 header',
  '0xA2 header',
  '0x66 neutral fixed',
];

// ═══════════════════════════════════════════════════════════
//  PHASE A: Smart handshake with protocol upgrade
// ═══════════════════════════════════════════════════════════
function connectWithUpgrade(format) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setNoDelay(true);
    sock.setTimeout(0);

    let state = 'INIT';         // INIT → GOT_A1 → UPGRADED → CONTROL
    let controlInterval = null;
    let alive = true;
    let aliveTimer = null;

    sock.on('connect', () => {
      console.log(`  [${ts()}] ✅ Connected to TCP ${CMD_PORT}`);
      console.log(`  [${ts()}] Sending ONE init (0xA0)...`);
      state = 'INIT';

      // Send ONLY ONE 0xA0 init
      sock.write(Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    });

    sock.on('data', (data) => {
      repliesReceived++;
      const hex = data.toString('hex');
      const ascii = data.toString('ascii').replace(/[^\x20-\x7e]/g, '');

      if (state === 'INIT' && data[0] === 0xA1) {
        state = 'GOT_A1';
        console.log(`  [${ts()}] 📨 Got 0xA1 ack (${data.length}B)`);
        console.log(`  [${ts()}] Waiting for "Upgrade_ok"... (NOT sending more 0xA0!)`);
      }

      if ((state === 'INIT' || state === 'GOT_A1') && ascii.includes('Upgrade_ok')) {
        state = 'UPGRADED';
        upgraded = true;
        console.log(`  [${ts()}] 📨 Got "Upgrade_ok"!`);
        console.log(`  [${ts()}] Protocol upgraded! Switching to control format: ${FORMAT_NAMES[format]}`);

        // NOW start sending control packets (NOT 0xA0 anymore!)
        controlInterval = setInterval(() => {
          if (!alive) { clearInterval(controlInterval); return; }
          try {
            const pkt = buildControlPacket(format);
            sock.write(pkt);
            packetsSent++;
          } catch(e) {
            clearInterval(controlInterval);
          }
        }, 50);

        // Track how long the connection stays alive
        aliveTimer = setTimeout(() => {
          if (alive && state === 'UPGRADED') {
            console.log(`  [${ts()}] 🎉🎉🎉 CONNECTION ALIVE FOR 5 SECONDS! Format ${format} works!`);
          }
        }, 5000);

        return;
      }

      if (state === 'UPGRADED') {
        // We got data AFTER upgrade with control packets!
        console.log(`\n  [${ts()}] 🎉 DRONE REPLIED IN CONTROL MODE!`);
        console.log(`  HEX: ${hex.substring(0, 80)}`);
        console.log(`  ASCII: ${ascii.substring(0, 80)}`);
        console.log(`  Length: ${data.length} bytes`);

        // Analyze for telemetry
        for (let i = 0; i < Math.min(data.length, 20); i++) {
          if (data[i] !== 0x00) {
            console.log(`    Byte[${i}] = 0x${data[i].toString(16).padStart(2, '0')} (${data[i]})`);
          }
        }
      }
    });

    sock.on('close', () => {
      alive = false;
      if (controlInterval) clearInterval(controlInterval);
      if (aliveTimer) clearTimeout(aliveTimer);

      if (state === 'UPGRADED') {
        console.log(`  [${ts()}] Connection closed AFTER upgrade (sent ${packetsSent} control packets)`);
        if (packetsSent < 5) {
          console.log(`  → Drone rejected format ${format} (${FORMAT_NAMES[format]})`);
        } else {
          console.log(`  → Format ${format} kept alive for ${packetsSent} packets!`);
        }
      } else {
        console.log(`  [${ts()}] Connection closed in state: ${state} (sent ${packetsSent} pkts)`);
      }

      resolve({ format, packetsSent, state });
    });

    sock.on('error', (err) => {
      alive = false;
      console.log(`  [${ts()}] Error: ${err.message}`);
      resolve({ format, packetsSent: 0, state });
    });

    sock.connect(CMD_PORT, DRONE);
  });
}

// ═══════════════════════════════════════════════════════════
//  PHASE B: Try RTSP on 7070 while 5007 is "upgraded"
// ═══════════════════════════════════════════════════════════
function tryRtspWhileUpgraded() {
  return new Promise((resolve) => {
    console.log(`\n  [${ts()}] Phase B: Opening 5007 + 7070 simultaneously...`);

    // Hold 5007 open with proper handshake
    const cmdSock = new net.Socket();
    cmdSock.setNoDelay(true);
    let cmdReady = false;

    cmdSock.on('connect', () => {
      cmdSock.write(Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    });
    cmdSock.on('data', (data) => {
      const ascii = data.toString('ascii').replace(/[^\x20-\x7e]/g, '');
      if (ascii.includes('Upgrade_ok')) {
        cmdReady = true;
        console.log(`  [${ts()}] 5007 upgraded! Now trying RTSP on 7070...`);

        // Start sending control packets on 5007
        const iv = setInterval(() => {
          try {
            cmdSock.write(Buffer.from([0x66, 0x80, 0x80, 0x00, 0x80, 0x00, 0x00, 0x99]));
          } catch(e) { clearInterval(iv); }
        }, 50);

        // Now try RTSP paths on 7070
        const rtspSock = new net.Socket();
        rtspSock.setTimeout(5000);
        let cseq = 1;
        const paths = ['/', '/live', '/stream', '/video', '/h264',
                       '/0', '/1', '/ch0', '/media', '/cam',
                       '/livestream', '/live.sdp', '/live/0',
                       '/live/ch00_0', '/av0_0'];
        let pi = 0;
        let foundPath = null;
        let buf = '';

        rtspSock.on('connect', () => {
          sendDescribe();
        });

        function sendDescribe() {
          if (pi >= paths.length) {
            rtspSock.destroy();
            return;
          }
          const p = paths[pi++];
          rtspSock.write(`DESCRIBE rtsp://${DRONE}:${VIDEO_PORT}${p} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAccept: application/sdp\r\n\r\n`);
        }

        rtspSock.on('data', (data) => {
          buf += data.toString();
          while (buf.includes('\r\n\r\n')) {
            const end = buf.indexOf('\r\n\r\n') + 4;
            const resp = buf.substring(0, end);
            buf = buf.substring(end);

            const code = parseInt((resp.match(/RTSP\/1\.0\s+(\d+)/) || [])[1] || '0');
            const path = paths[pi - 1];

            if (code === 200) {
              foundPath = path;
              console.log(`\n  🎉 RTSP PATH FOUND (while 5007 upgraded): ${path}`);
              resp.split('\r\n').forEach(l => { if (l.trim()) console.log(`    ${l}`); });
            } else {
              if (pi % 5 === 0) process.stdout.write(`\r    Tried ${pi}/${paths.length} RTSP paths (${code})...  `);
            }
            sendDescribe();
          }
        });

        rtspSock.on('timeout', () => rtspSock.destroy());
        rtspSock.on('error', () => {});
        rtspSock.on('close', () => {
          console.log(foundPath ? `\n  RTSP path: ${foundPath}` : `\n  No RTSP path unlocked.`);
          clearInterval(iv);
          cmdSock.destroy();
          resolve(foundPath);
        });

        rtspSock.connect(VIDEO_PORT, DRONE);
      }
    });
    cmdSock.on('error', () => resolve(null));
    cmdSock.on('close', () => {
      if (!cmdReady) resolve(null);
    });
    cmdSock.connect(CMD_PORT, DRONE);
  });
}

// ═══════════════════════════════════════════════════════════
//  PHASE C: Try raw TCP video read on 7070 while 5007 upgraded
// ═══════════════════════════════════════════════════════════
function tryRawVideoWhileUpgraded() {
  return new Promise((resolve) => {
    console.log(`\n  [${ts()}] Phase C: Raw TCP listen on 7070 while 5007 controls...`);

    const cmdSock = new net.Socket();
    cmdSock.setNoDelay(true);

    cmdSock.on('connect', () => {
      cmdSock.write(Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    });

    let cmdUpgraded = false;
    cmdSock.on('data', (data) => {
      const ascii = data.toString('ascii').replace(/[^\x20-\x7e]/g, '');
      if (ascii.includes('Upgrade_ok') && !cmdUpgraded) {
        cmdUpgraded = true;

        // Send control packets on 5007
        const iv = setInterval(() => {
          try { cmdSock.write(Buffer.from([0x66, 0x80, 0x80, 0x00, 0x80, 0x00, 0x00, 0x99])); }
          catch(e) { clearInterval(iv); }
        }, 50);

        // Try sending video commands on 7070
        const vidSock = new net.Socket();
        vidSock.setTimeout(8000);
        let gotVideo = false;

        vidSock.on('connect', () => {
          console.log(`  Connected to 7070. Trying video trigger commands...`);

          // Try various video start commands
          const cmds = [
            Buffer.from([0xEF, 0x00, 0x04, 0x00]),                          // E58 video start
            Buffer.from([0x66, 0x80, 0x80, 0x00, 0x80, 0x40, 0x00, 0x99]),  // Control with video flag
            Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),  // Same init as 5007
          ];

          let ci = 0;
          const sendCmd = () => {
            if (ci >= cmds.length) return;
            const cmd = cmds[ci++];
            console.log(`  → Sending to 7070: ${cmd.toString('hex')}`);
            vidSock.write(cmd);
            setTimeout(sendCmd, 1000);
          };
          sendCmd();
        });

        vidSock.on('data', (vdata) => {
          gotVideo = true;
          console.log(`\n  🎉 PORT 7070 SENT DATA while 5007 is active!`);
          console.log(`  Size: ${vdata.length} bytes`);
          console.log(`  HEX: ${vdata.toString('hex').substring(0, 80)}`);
          console.log(`  ASCII: ${vdata.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 80)}`);

          if (vdata[0] === 0xFF && vdata[1] === 0xD8) console.log(`  FORMAT: JPEG!`);
          if (vdata[0] === 0x00 && vdata[1] === 0x00 && vdata[2] === 0x00 && vdata[3] === 0x01) console.log(`  FORMAT: H264!`);
        });

        vidSock.on('timeout', () => {
          if (!gotVideo) console.log(`  7070 silent (no raw video).`);
          vidSock.destroy();
          clearInterval(iv);
          cmdSock.destroy();
          resolve(gotVideo);
        });
        vidSock.on('error', () => {});
        vidSock.on('close', () => {
          clearInterval(iv);
          cmdSock.destroy();
          resolve(gotVideo);
        });
        vidSock.connect(VIDEO_PORT, DRONE);
      }
    });
    cmdSock.on('error', () => resolve(false));
    cmdSock.on('close', () => {
      if (!cmdUpgraded) resolve(false);
    });
    cmdSock.connect(CMD_PORT, DRONE);
  });
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🛸 DRONE CONTROLLER v4.0 — TCP PROTOCOL UPGRADE        ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Theory: "Upgrade_ok" = protocol upgrade, not firmware   ║');
  console.log('║  After upgrade, switch from 0xA0 to control packets      ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Phase A: Test 6 control formats after upgrade           ║');
  console.log('║  Phase B: Try RTSP paths while 5007 is upgraded          ║');
  console.log('║  Phase C: Raw video on 7070 while 5007 controls          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ─── Phase A: Try each control format after upgrade ─────
  console.log('═══ PHASE A: Control Format Discovery ═══\n');

  let bestFormat = -1;
  let bestPackets = 0;

  for (let f = 0; f < FORMAT_NAMES.length; f++) {
    console.log(`\n  ── Testing format ${f}: ${FORMAT_NAMES[f]} ──`);
    packetsSent = 0;
    repliesReceived = 0;
    upgraded = false;

    const result = await connectWithUpgrade(f);

    if (result.packetsSent > bestPackets) {
      bestPackets = result.packetsSent;
      bestFormat = f;
    }

    // Small delay between tests
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n\n  📊 Best format: ${bestFormat >= 0 ? FORMAT_NAMES[bestFormat] : 'none'} (${bestPackets} packets before disconnect)\n`);

  // ─── Phase B: RTSP while upgraded ──────────────────────
  console.log('═══ PHASE B: RTSP paths while 5007 is upgraded ═══');
  const rtspPath = await tryRtspWhileUpgraded();

  // ─── Phase C: Raw video while upgraded ─────────────────
  console.log('\n═══ PHASE C: Raw video on 7070 while controlling ═══');
  const gotVideo = await tryRawVideoWhileUpgraded();

  // ─── Summary ──────────────────────────────────────────
  console.log('\n' + '═'.repeat(58));
  console.log('  📊 FINAL RESULTS');
  console.log('═'.repeat(58));
  console.log(`  Best control format: ${bestFormat >= 0 ? `${FORMAT_NAMES[bestFormat]} (${bestPackets} pkts)` : 'none survived'}`);
  console.log(`  RTSP path: ${rtspPath || 'none found'}`);
  console.log(`  Raw video: ${gotVideo ? 'YES!' : 'no'}`);
  console.log('═'.repeat(58));

  process.exit();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
