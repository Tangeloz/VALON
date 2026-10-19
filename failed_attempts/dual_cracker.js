/*
 * DUAL PORT CRACKER — Ports 5007 + 7070
 * 
 * CONFIRMED OPEN PORTS:
 *   TCP 5007 — silent on hex probes, resets on HTTP/RTSP
 *   TCP 7070 — newly discovered, untested
 *
 * KEY INSIGHT: The real app probably connects to BOTH simultaneously.
 * One is likely video, the other is likely control.
 *
 * THIS SCRIPT:
 *   Test 1: Probe port 7070 (never tested before!)
 *   Test 2: Connect to BOTH ports simultaneously
 *   Test 3: Binary first-byte sweep on 7070
 *   Test 4: Hold both TCP open, then fire UDP
 *   Test 5: Try "init on one, read on the other" pattern
 *
 * RUNTIME: ~5 minutes (fast & focused)
 */

const net = require('net');
const dgram = require('dgram');

const DRONE = '192.168.1.1';
const PORTS = [5007, 7070];

function ts() { return new Date().toLocaleTimeString(); }

const PROBES = {
  'KY UFO Init':     Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
  'KY UFO Alt':      Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
  'cooingdv Init':   Buffer.from([0xEF, 0x00, 0x04, 0x00]),
  'Heartbeat':       Buffer.from([0x63, 0x63, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]),
  'Null 4':          Buffer.from([0x00, 0x00, 0x00, 0x00]),
  'JJRC hello':      Buffer.from([0xFF, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]),
  'Connect 0x28':    Buffer.from([0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40]),
  'AA init':         Buffer.from([0xAA, 0x02, 0x00, 0x00]),
  '0x26 variant':    Buffer.from([0x26, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0xB9]),
  'Single 0x00':     Buffer.from([0x00]),
  'Single 0xFF':     Buffer.from([0xFF]),
  'HTTP GET':        Buffer.from('GET / HTTP/1.0\r\n\r\n'),
  'RTSP OPTIONS':    Buffer.from('OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n'),
  'JSON cmd':        Buffer.from('{"cmd":"connect"}\n'),
  'Raw CR LF':       Buffer.from('\r\n'),
};

// ═══════════════════════════════════════════════════════════════
//  TEST 1: Basic probe on port 7070 (we know 5007 already)
// ═══════════════════════════════════════════════════════════════
function test1_probe7070() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 1: INTERROGATE PORT 7070 (never tested before!)    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // First: silent connect
    const sock = new net.Socket();
    sock.setTimeout(5000);
    let gotData = false;

    sock.on('connect', () => {
      console.log('  ✅ Connected to TCP 7070!');
      console.log('  Waiting 5 seconds to see if it talks first...');
    });

    sock.on('data', (data) => {
      gotData = true;
      console.log(`\n  📨 PORT 7070 SPOKE!`);
      console.log(`  Bytes:  ${data.length}`);
      console.log(`  HEX:    ${data.toString('hex').substring(0, 120)}`);
      console.log(`  ASCII:  ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 120)}`);
    });

    sock.on('timeout', () => {
      if (!gotData) console.log('  (Silent for 5 seconds.)');
      sock.destroy();
    });

    sock.on('error', (err) => {
      console.log(`  ❌ Port 7070 error: ${err.message}`);
      console.log('  (Port might have closed. Drone ports can be flaky.)');
    });

    sock.on('close', () => {
      // Now send each probe
      console.log('\n  Sending probes to 7070 one at a time:\n');
      const probeNames = Object.keys(PROBES);
      let idx = 0;

      function nextProbe() {
        if (idx >= probeNames.length) { resolve(); return; }

        const name = probeNames[idx++];
        const payload = PROBES[name];
        const s = new net.Socket();
        s.setTimeout(1500);
        let replied = false;

        s.on('connect', () => {
          process.stdout.write(`  [${name}] → ${payload.length}B ... `);
          s.write(payload);
        });

        s.on('data', (data) => {
          replied = true;
          console.log(`\n  🎉 PORT 7070 REPLIED to "${name}"!`);
          console.log(`     HEX:   ${data.toString('hex').substring(0, 100)}`);
          console.log(`     ASCII: ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 100)}`);
        });

        s.on('timeout', () => {
          if (!replied) process.stdout.write('silent\n');
          s.destroy();
        });
        s.on('error', (err) => {
          if (!replied) process.stdout.write(`${err.code || err.message}\n`);
        });
        s.on('close', () => setTimeout(nextProbe, 200));

        s.connect(7070, DRONE);
      }

      nextProbe();
    });

    sock.connect(7070, DRONE);
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST 2: Connect to BOTH ports at the same time
//  The real app probably opens both connections simultaneously.
// ═══════════════════════════════════════════════════════════════
function test2_dualConnect() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 2: DUAL CONNECT — both ports at once               ║');
    console.log('║  The real app probably connects to both simultaneously    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const sockets = {};
    let connected = 0;

    PORTS.forEach(port => {
      const sock = new net.Socket();
      sock.setTimeout(10000);
      sockets[port] = sock;

      sock.on('connect', () => {
        console.log(`  ✅ Connected to ${port}`);
        connected++;

        if (connected === PORTS.length) {
          console.log('\n  Both ports open! Waiting 3 seconds for auto-stream...\n');
          setTimeout(() => {
            // Send init probe to each
            console.log('  Sending KY UFO init to BOTH ports...');
            const init = Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]);
            PORTS.forEach(p => sockets[p].write(init));

            setTimeout(() => {
              console.log('\n  Sending cooingdv init to BOTH ports...');
              const init2 = Buffer.from([0xEF, 0x00, 0x04, 0x00]);
              PORTS.forEach(p => {
                try { sockets[p].write(init2); } catch(e) {}
              });

              setTimeout(() => {
                console.log('\n  Sending init to 5007, listening on 7070...');
                try {
                  sockets[5007].write(Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]));
                  sockets[5007].write(Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]));
                  sockets[5007].write(Buffer.from([0xEF, 0x00, 0x04, 0x00]));
                } catch(e) {}

                setTimeout(() => {
                  console.log('  Sending init to 7070, listening on 5007...');
                  try {
                    sockets[7070].write(Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]));
                    sockets[7070].write(Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]));
                    sockets[7070].write(Buffer.from([0xEF, 0x00, 0x04, 0x00]));
                  } catch(e) {}

                  setTimeout(() => {
                    PORTS.forEach(p => { try { sockets[p].destroy(); } catch(e) {} });
                    resolve();
                  }, 5000);
                }, 2000);
              }, 2000);
            }, 2000);
          }, 3000);
        }
      });

      sock.on('data', (data) => {
        console.log(`\n  📨📨📨 PORT ${port} REPLIED!`);
        console.log(`  Bytes:  ${data.length}`);
        console.log(`  HEX:    ${data.toString('hex').substring(0, 120)}`);
        console.log(`  ASCII:  ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 120)}`);
      });

      sock.on('error', (err) => {
        console.log(`  ❌ Port ${port}: ${err.message}`);
        connected++;
        if (connected === PORTS.length) {
          setTimeout(resolve, 1000);
        }
      });

      sock.connect(port, DRONE);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST 3: First-byte sweep on port 7070
// ═══════════════════════════════════════════════════════════════
function test3_byteSweep7070() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 3: BYTE SWEEP on 7070 (0x00–0xFF)                  ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    let b = 0;
    let found = false;

    function tryByte() {
      if (found || b > 0xFF) {
        if (!found) console.log('\n  No single byte triggered a reply on 7070.');
        resolve(found);
        return;
      }

      const payload = Buffer.from([b, 0x00, 0x00, 0x00]);
      const sock = new net.Socket();
      sock.setTimeout(300);

      sock.on('connect', () => sock.write(payload));
      sock.on('data', (data) => {
        found = true;
        console.log(`\n  🎉 7070 REPLIED to byte 0x${b.toString(16).padStart(2,'0')}!`);
        console.log(`  Sent:  ${payload.toString('hex')}`);
        console.log(`  Got:   ${data.toString('hex').substring(0, 100)}`);
        console.log(`  ASCII: ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 100)}`);
        sock.destroy();
      });

      sock.on('timeout', () => sock.destroy());
      sock.on('error', () => {});
      sock.on('close', () => {
        b++;
        if (b % 32 === 0) {
          process.stdout.write(`\r  Testing 0x${b.toString(16).padStart(2,'0')} (${((b/256)*100).toFixed(0)}%)   `);
        }
        setTimeout(tryByte, 15);
      });

      sock.connect(7070, DRONE);
    }

    tryByte();
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST 4: Hold BOTH TCP open + fire UDP everywhere
// ═══════════════════════════════════════════════════════════════
function test4_dualTcpThenUdp() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 4: HOLD BOTH TCP + FIRE UDP                        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const tcpSocks = [];
    let tcpReady = 0;

    PORTS.forEach(port => {
      const s = new net.Socket();
      s.setTimeout(30000);
      s.on('connect', () => {
        console.log(`  ✅ TCP ${port} held open`);
        tcpReady++;
        if (tcpReady === PORTS.length) fireUdp();
      });
      s.on('data', (data) => {
        console.log(`\n  📨 TCP ${port} DATA while UDP was firing!`);
        console.log(`  HEX: ${data.toString('hex').substring(0, 100)}`);
      });
      s.on('error', () => { tcpReady++; if (tcpReady === PORTS.length) fireUdp(); });
      tcpSocks.push(s);
      s.connect(port, DRONE);
    });

    function fireUdp() {
      console.log('  Firing UDP probes on ALL common ports...\n');

      const udpPorts = [
        ...Array.from({length: 21}, (_, i) => 5000 + i),
        ...Array.from({length: 21}, (_, i) => 7060 + i),
        8800, 8080, 40000, 50000, 8888, 9090, 5555, 80,
        8000, 9000, 10000, 20000, 1234, 4567, 2345
      ];

      const UDP_PROBES = [
        Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
        Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
        Buffer.from([0xEF, 0x00, 0x04, 0x00]),
      ];

      const sock = dgram.createSocket('udp4');
      sock.on('message', (msg, rinfo) => {
        if (rinfo.address === '127.0.0.1') return;
        console.log(`\n  🎉 UDP REPLY from ${rinfo.address}:${rinfo.port}!`);
        console.log(`  HEX: ${msg.toString('hex').substring(0, 80)}`);
      });

      sock.bind(0, () => {
        sock.setBroadcast(true);
        let i = 0;
        const interval = setInterval(() => {
          if (i >= udpPorts.length) {
            clearInterval(interval);
            console.log('  Waiting 5 seconds...');
            setTimeout(() => {
              sock.close();
              tcpSocks.forEach(s => { try { s.destroy(); } catch(e) {} });
              resolve();
            }, 5000);
            return;
          }
          const port = udpPorts[i++];
          UDP_PROBES.forEach(p => sock.send(p, 0, p.length, port, DRONE));
        }, 100);
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════════
//  TEST 5: Quick scan of nearby ports (in case we missed some)
//  Scan ranges: 4900-5100 and 6900-7200
// ═══════════════════════════════════════════════════════════════
function test5_neighborScan() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST 5: NEIGHBOR SCAN (ports near 5007 and 7070)        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const ranges = [];
    for (let p = 4900; p <= 5100; p++) ranges.push(p);
    for (let p = 6900; p <= 7200; p++) ranges.push(p);

    const found = [];
    let idx = 0;
    let active = 0;

    function launch() {
      while (active < 10 && idx < ranges.length) {
        const port = ranges[idx++];
        active++;

        const s = new net.Socket();
        s.setTimeout(2000);
        s.on('connect', () => {
          console.log(`  🔥 OPEN: ${port}`);
          found.push(port);
          s.destroy();
        });
        s.on('timeout', () => s.destroy());
        s.on('error', () => {});
        s.on('close', () => {
          active--;
          if (idx >= ranges.length && active === 0) {
            console.log(`\n  Neighbor scan done. Open: ${found.join(', ') || 'only 5007, 7070'}`);
            resolve(found);
          } else {
            launch();
          }
        });

        s.connect(port, DRONE);
      }
    }

    launch();
  });
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║  🛸 DUAL PORT CRACKER — 5007 + 7070                      ║');
  console.log('╠' + '═'.repeat(58) + '╣');
  console.log('║  Test 1: Interrogate 7070 (new port!)                     ║');
  console.log('║  Test 2: Dual connect (both at once)                      ║');
  console.log('║  Test 3: Byte sweep on 7070                               ║');
  console.log('║  Test 4: Hold both TCP + fire UDP                         ║');
  console.log('║  Test 5: Scan neighbors (4900-5100, 6900-7200)            ║');
  console.log('║                                                           ║');
  console.log('║  ⏱️  ETA: ~5 minutes                                      ║');
  console.log('╚' + '═'.repeat(58) + '╝');

  await test1_probe7070();
  await test2_dualConnect();
  await test3_byteSweep7070();
  await test4_dualTcpThenUdp();
  const neighbors = await test5_neighborScan();

  console.log('\n' + '═'.repeat(60));
  console.log('  📊 FINAL REPORT');
  console.log('═'.repeat(60));
  console.log(`  Known ports: 5007, 7070`);
  console.log(`  Neighbor ports: ${neighbors.join(', ') || 'none extra'}`);
  console.log('  Check above for any 🎉 hits!');
  console.log('═'.repeat(60));
  process.exit();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
