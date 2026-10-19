/*
 * 🛸 REAL PROTOCOL FINDER v4
 *
 * CRITICAL DISCOVERY:
 *   The 0xA0 command triggers FIRMWARE UPGRADE MODE!
 *   Drone responds: 0xA1 (ack) → "Upgrade_ok\0" → closes connection.
 *   This is NOT the flight control command!
 *
 *   The drone clearly understands NULL-TERMINATED TEXT strings.
 *   This is typical of ESP8266/Hi3518 based drone WiFi modules.
 *
 * STRATEGY:
 *   1. Try text-based commands on port 5007
 *   2. Try responding TO the "Upgrade_ok" message
 *   3. Scan remaining TCP ports (15000-65535) — we never finished!
 *   4. Try connecting to 7070 AND 5007 together with text commands
 */

const net = require('net');
const dgram = require('dgram');

const DRONE = '192.168.1.1';
const CMD_PORT = 5007;
const VIDEO_PORT = 7070;

function ts() { return new Date().toLocaleTimeString(); }

// ═══════════════════════════════════════════════════════════════
//  TEST 1: Text commands on port 5007
//  The drone understands null-terminated strings. Let's talk!
// ═══════════════════════════════════════════════════════════════
function test1_textCommands() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 1: TEXT COMMANDS on port 5007                      ║');
    console.log('║  Drone speaks text ("Upgrade_ok") — find the real cmd    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const textCmds = [
      // Connection/init commands
      'connect\0',
      'Connect\0',
      'CONNECT\0',
      'conn_req:\0',
      'conn_ack\0',
      'init\0',
      'Init\0',
      'hello\0',
      'Hello\0',
      'start\0',
      'Start\0',
      'START\0',
      'login\0',
      'Login\0',
      'open\0',
      'Open\0',
      'ready\0',
      'Ready\0',
      'READY\0',
      'control\0',
      'Control\0',
      'CONTROL\0',
      'fly\0',
      'Fly\0',
      'FLY\0',

      // Status/query commands
      'status\0',
      'Status\0',
      'query\0',
      'version\0',
      'Version\0',
      'info\0',
      'Info\0',
      'get_status\0',
      'get_version\0',
      'get_info\0',

      // Video commands
      'video\0',
      'Video\0',
      'VIDEO\0',
      'stream\0',
      'Stream\0',
      'camera\0',
      'Camera\0',
      'start_video\0',
      'video_start\0',
      'video_on\0',
      'cam_on\0',
      'preview\0',

      // Calibration
      'calibrate\0',
      'Calibrate\0',
      'calib\0',
      'gyro\0',

      // Common IoT/embedded commands
      'AT\r\n',
      'AT+\r\n',
      'help\0',
      'help\r\n',
      '?\0',
      '?\r\n',
      'list\0',
      'cmd\0',
      'ping\0',
      'test\0',
      'echo\0',

      // Drone-specific
      'takeoff\0',
      'land\0',
      'unlock\0',
      'lock\0',
      'arm\0',
      'disarm\0',

      // Without null terminator (just \r\n)
      'connect\r\n',
      'start\r\n',
      'video\r\n',
      'status\r\n',
      'control\r\n',
      'hello\r\n',
      'init\r\n',
      'ready\r\n',

      // Chinese drone specific
      'conn_req:lh\0',
      'conn_ack\0',
      'controller\0',
    ];

    let idx = 0;
    let found = [];

    function tryNext() {
      if (idx >= textCmds.length) {
        if (found.length > 0) {
          console.log(`\n  🎉 Commands that got replies:`);
          found.forEach(f => {
            console.log(`     "${f.cmd}" → ${f.reply}`);
          });
        } else {
          console.log(`\n  No text command got a reply on 5007.`);
        }
        resolve(found);
        return;
      }

      const cmd = textCmds[idx++];
      const cmdDisplay = cmd.replace(/\0/g, '\\0').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

      const sock = new net.Socket();
      sock.setNoDelay(true);
      sock.setTimeout(1500);
      let replied = false;

      sock.on('connect', () => {
        process.stdout.write(`  "${cmdDisplay}" → `);
        sock.write(Buffer.from(cmd));
      });

      sock.on('data', (data) => {
        replied = true;
        const hex = data.toString('hex');
        const ascii = data.toString('ascii').replace(/[^\x20-\x7e]/g, '.');

        // Filter out the "Upgrade_ok" response (we already know about that from 0xA0)
        if (ascii.includes('Upgrade_ok') || hex.startsWith('a1')) {
          process.stdout.write(`(Upgrade_ok / 0xA1 — skip)\n`);
        } else {
          console.log(`\n  🎉 NEW REPLY to "${cmdDisplay}"!`);
          console.log(`     HEX:   ${hex.substring(0, 80)}`);
          console.log(`     ASCII: ${ascii.substring(0, 80)}`);
          console.log(`     LEN:   ${data.length}`);
          found.push({ cmd: cmdDisplay, reply: ascii.substring(0, 60) });
        }
      });

      sock.on('timeout', () => {
        if (!replied) process.stdout.write('silent\n');
        sock.destroy();
      });
      sock.on('error', (err) => {
        if (!replied) process.stdout.write(`${err.code}\n`);
      });
      sock.on('close', () => {
        setTimeout(tryNext, 80);
      });

      sock.connect(CMD_PORT, DRONE);
    }

    tryNext();
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST 2: Respond TO the "Upgrade_ok" message
//  Maybe after "Upgrade_ok" we need to send something to enter
//  control mode (like a firmware protocol handshake)
// ═══════════════════════════════════════════════════════════════
function test2_respondToUpgrade() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 2: RESPOND to "Upgrade_ok"                         ║');
    console.log('║  Maybe we need to complete the handshake                  ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const responses = [
      'ok\0',
      'OK\0',
      'ack\0',
      'ACK\0',
      'ready\0',
      'start\0',
      'Upgrade_done\0',
      'Upgrade_complete\0',
      'connect\0',
      'control\0',
      Buffer.from([0xA1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0xA2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x00]),
      Buffer.from([0x01]),
      Buffer.from([0xFF]),
    ];

    let idx = 0;

    function tryNext() {
      if (idx >= responses.length) {
        console.log('\n  No response to "Upgrade_ok" worked.');
        resolve();
        return;
      }

      const response = responses[idx++];
      const display = Buffer.isBuffer(response)
        ? `0x${response.toString('hex')}`
        : response.replace(/\0/g, '\\0');

      const sock = new net.Socket();
      sock.setNoDelay(true);
      sock.setTimeout(3000);
      let phase = 0; // 0=waiting for A1, 1=waiting for Upgrade_ok, 2=sent response

      sock.on('connect', () => {
        // Send init to trigger the handshake
        sock.write(Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      });

      sock.on('data', (data) => {
        const ascii = data.toString('ascii').replace(/[^\x20-\x7e]/g, '');

        if (phase === 0 && data[0] === 0xA1) {
          phase = 1;
          // Don't do anything yet, wait for "Upgrade_ok"
        } else if (phase <= 1 && ascii.includes('Upgrade_ok')) {
          phase = 2;
          process.stdout.write(`  After Upgrade_ok, sending "${display}" → `);
          // NOW send our response
          const buf = Buffer.isBuffer(response) ? response : Buffer.from(response);
          sock.write(buf);
        } else if (phase === 2) {
          // We got a reply AFTER our response!
          console.log(`\n  🎉🎉 DRONE REPLIED AFTER "${display}"!`);
          console.log(`     HEX:   ${data.toString('hex').substring(0, 80)}`);
          console.log(`     ASCII: ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 80)}`);
        }
      });

      sock.on('timeout', () => {
        if (phase < 2) process.stdout.write(`(never got Upgrade_ok)\n`);
        else process.stdout.write(`silent\n`);
        sock.destroy();
      });
      sock.on('error', () => {});
      sock.on('close', () => setTimeout(tryNext, 100));

      sock.connect(CMD_PORT, DRONE);
    }

    tryNext();
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST 3: Scan remaining TCP ports (15000-65535)
//  Our previous scan only got to 23%. The REAL control port
//  might be somewhere above 15000.
// ═══════════════════════════════════════════════════════════════
function test3_scanRemainingPorts() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 3: SCAN PORTS 15000–65535 (never scanned!)         ║');
    console.log('║  20 at a time — same speed that found 5007 and 7070      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const openPorts = [];
    let current = 15000;
    let active = 0;
    const MAX = 20;

    function launch() {
      while (active < MAX && current <= 65535) {
        const port = current++;
        active++;

        const sock = new net.Socket();
        sock.setTimeout(2000);

        sock.on('connect', () => {
          console.log(`  🔥 OPEN: ${DRONE}:${port}`);
          openPorts.push(port);
          sock.destroy();
        });

        sock.on('timeout', () => sock.destroy());
        sock.on('error', () => {});
        sock.on('close', () => {
          active--;
          if (current % 5000 === 0) {
            process.stdout.write(`\r  [${ts()}] Scanned ${current}/65535 (${((current/65535)*100).toFixed(0)}%) — Found: ${openPorts.length}   `);
          }
          if (current > 65535 && active === 0) {
            console.log(`\n\n  Scan complete! New ports: ${openPorts.join(', ') || 'none'}`);
            resolve(openPorts);
          } else {
            launch();
          }
        });

        sock.connect(port, DRONE);
      }
    }

    launch();
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST 4: Try text commands on port 7070
//  We know it speaks RTSP. But maybe it also speaks text commands.
// ═══════════════════════════════════════════════════════════════
function test4_textOn7070() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 4: TEXT COMMANDS on port 7070                      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const cmds = [
      'connect\0', 'start\0', 'video\0', 'stream\0', 'play\0',
      'start_video\0', 'video_start\0', 'cam_on\0', 'preview\0',
      'status\0', 'hello\0', 'init\0', 'control\0', 'ready\0',
      Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ];

    let idx = 0;

    function tryNext() {
      if (idx >= cmds.length) {
        resolve();
        return;
      }

      const cmd = cmds[idx++];
      const display = Buffer.isBuffer(cmd) ? `0x${cmd.toString('hex')}` : cmd.replace(/\0/g, '\\0');
      const buf = Buffer.isBuffer(cmd) ? cmd : Buffer.from(cmd);

      const sock = new net.Socket();
      sock.setTimeout(1500);
      let replied = false;

      sock.on('connect', () => {
        process.stdout.write(`  7070: "${display}" → `);
        sock.write(buf);
      });

      sock.on('data', (data) => {
        replied = true;
        const ascii = data.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
        if (ascii.includes('RTSP') || ascii.includes('404')) {
          process.stdout.write(`RTSP response (skip)\n`);
        } else {
          console.log(`\n  🎉 7070 REPLIED to "${display}"!`);
          console.log(`     HEX:   ${data.toString('hex').substring(0, 80)}`);
          console.log(`     ASCII: ${ascii.substring(0, 80)}`);
        }
      });

      sock.on('timeout', () => {
        if (!replied) process.stdout.write('silent\n');
        sock.destroy();
      });
      sock.on('error', () => {});
      sock.on('close', () => setTimeout(tryNext, 80));

      sock.connect(VIDEO_PORT, DRONE);
    }

    tryNext();
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST 5: Interrogate any NEW ports found in Test 3
// ═══════════════════════════════════════════════════════════════
function test5_interrogateNew(ports) {
  return new Promise((resolve) => {
    if (ports.length === 0) { resolve(); return; }

    console.log(`\n╔══════════════════════════════════════════════════════════╗`);
    console.log(`║  TEST 5: INTERROGATE NEW PORTS: ${ports.join(', ').substring(0, 22).padEnd(22)}║`);
    console.log(`╚══════════════════════════════════════════════════════════╝\n`);

    let idx = 0;

    function probeNext() {
      if (idx >= ports.length) { resolve(); return; }

      const port = ports[idx++];
      console.log(`\n  --- Port ${port} ---`);

      // First: silent listen
      const s1 = new net.Socket();
      s1.setTimeout(3000);
      let gotData = false;

      s1.on('connect', () => {
        console.log(`  Connected. Listening...`);
      });

      s1.on('data', (data) => {
        gotData = true;
        console.log(`  📨 Port ${port} SPEAKS!`);
        console.log(`     HEX:   ${data.toString('hex').substring(0, 80)}`);
        console.log(`     ASCII: ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 80)}`);
      });

      s1.on('timeout', () => {
        if (!gotData) {
          // Try some probes
          console.log(`  Silent. Trying probes...`);
        }
        s1.destroy();
      });

      s1.on('error', (err) => console.log(`  Error: ${err.message}`));
      s1.on('close', () => {
        // Now try probes
        const probes = [
          { name: 'RTSP OPTIONS', data: Buffer.from('OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n') },
          { name: 'HTTP GET', data: Buffer.from('GET / HTTP/1.0\r\n\r\n') },
          { name: '0xA0 init', data: Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
          { name: 'connect\\0', data: Buffer.from('connect\0') },
          { name: 'hello\\0', data: Buffer.from('hello\0') },
          { name: 'status\\0', data: Buffer.from('status\0') },
        ];

        let pi = 0;
        function nextProbe() {
          if (pi >= probes.length) { probeNext(); return; }

          const probe = probes[pi++];
          const s2 = new net.Socket();
          s2.setTimeout(1000);
          let gotReply = false;

          s2.on('connect', () => {
            process.stdout.write(`  [${probe.name}] → `);
            s2.write(probe.data);
          });
          s2.on('data', (data) => {
            gotReply = true;
            const ascii = data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 60);
            console.log(`REPLY! (${data.length}B) ${ascii}`);
          });
          s2.on('timeout', () => {
            if (!gotReply) process.stdout.write('silent\n');
            s2.destroy();
          });
          s2.on('error', () => {});
          s2.on('close', () => setTimeout(nextProbe, 100));

          s2.connect(port, DRONE);
        }

        nextProbe();
      });

      s1.connect(port, DRONE);
    }

    probeNext();
  });
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║  🛸 REAL PROTOCOL FINDER v4                              ║');
  console.log('║  "Upgrade_ok" = we triggered firmware mode by accident!   ║');
  console.log('║  Now finding the REAL control protocol...                 ║');
  console.log('╠' + '═'.repeat(58) + '╣');
  console.log('║  Test 1: Text commands on 5007 (drone speaks text!)       ║');
  console.log('║  Test 2: Respond to "Upgrade_ok" handshake                ║');
  console.log('║  Test 3: Scan ports 15000–65535 (never finished!)         ║');
  console.log('║  Test 4: Text commands on 7070                            ║');
  console.log('║  Test 5: Interrogate any new ports                        ║');
  console.log('╚' + '═'.repeat(58) + '╝');

  // Test 1: Text commands
  const textResults = await test1_textCommands();

  // Test 2: Respond to Upgrade_ok
  await test2_respondToUpgrade();

  // Test 4: Text on 7070 (quick, do before long scan)
  await test4_textOn7070();

  // Test 3: Scan remaining ports
  const newPorts = await test3_scanRemainingPorts();

  // Test 5: Interrogate new ports
  if (newPorts.length > 0) {
    await test5_interrogateNew(newPorts);
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('  📊 PROTOCOL FINDER v4 — RESULTS');
  console.log('═'.repeat(60));
  console.log(`  Text command hits on 5007: ${textResults.length > 0 ? textResults.map(f => f.cmd).join(', ') : 'none'}`);
  console.log(`  New ports found (15000+): ${newPorts.join(', ') || 'none'}`);
  console.log('═'.repeat(60));
  process.exit();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
