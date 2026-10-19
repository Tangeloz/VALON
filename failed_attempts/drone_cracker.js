/*
 * DRONE CRACKER v3
 * 
 * WHAT WE KNOW NOW:
 *   - TCP 5007 is OPEN and ALIVE
 *   - It RESETS on HTTP/RTSP (knows those are wrong)
 *   - It STAYS SILENT on hex probes (listening but we haven't said the right word)
 *   - There might be MORE ports we missed (scan was killed early)
 *
 * STRATEGY:
 *   Phase 1: Find ALL open TCP ports near 5007 (4000-6000 range, then full)
 *   Phase 2: Connect to 5007, try systematic binary sequences
 *   Phase 3: Connect to 5007, THEN try UDP (maybe TCP "unlocks" the UDP channel)
 *   Phase 4: Try keeping TCP alive and reading — maybe it streams data after a delay
 */

const net = require('net');
const dgram = require('dgram');
const { exec } = require('child_process');

const DRONE = '192.168.1.1';
const FOUND_PORT = 5007;

function ts() { return new Date().toLocaleTimeString(); }

// ═══════════════════════════════════════════════════════════════
//  PHASE 1: Scan ports 1-65535 slowly, find ALL open TCP ports
//  We do 20 at a time like before (that's what found 5007)
// ═══════════════════════════════════════════════════════════════
function phase1_findAllPorts() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  PHASE 1: FIND ALL TCP PORTS (20 at a time)              ║');
    console.log('║  Scanning 1-65535 — the speed that found 5007            ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const openPorts = [];
    let current = 1;
    let active = 0;
    const MAX = 20;
    const TIMEOUT = 2000;

    function launch() {
      while (active < MAX && current <= 65535) {
        const port = current++;
        active++;

        const sock = new net.Socket();
        sock.setTimeout(TIMEOUT);

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
            process.stdout.write(`\r  [${ts()}] Scanned ${current}/65535 (${((current/65535)*100).toFixed(0)}%) — Found: ${openPorts.length} ports   `);
          }
          if (current > 65535 && active === 0) {
            console.log(`\n\n  ✅ Scan complete! Open ports: ${openPorts.join(', ') || 'none besides 5007'}`);
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
//  PHASE 2: Systematic binary cracking on port 5007
//  Since hex probes got silence (not rejection), the drone IS
//  listening — we just need the right start bytes.
//  
//  Strategy: Try every possible first byte (0x00-0xFF) followed
//  by common second bytes. If the drone replies to any, we found
//  the protocol header.
// ═══════════════════════════════════════════════════════════════
function phase2_crackProtocol(allPorts) {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  PHASE 2: BINARY PROTOCOL CRACKER on port 5007          ║');
    console.log('║  Trying every possible first byte (0x00–0xFF)            ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Try each possible first byte, with a few common patterns after it
    const suffixes = [
      Buffer.from([]),                                          // just 1 byte
      Buffer.from([0x00]),                                      // byte + 0x00
      Buffer.from([0x00, 0x00, 0x00]),                          // byte + 3 nulls
      Buffer.from([0x80, 0x80, 0x80, 0x80, 0x00, 0x00]),       // byte + cooingdv body
      Buffer.from([0x01, 0x00, 0x00, 0x00]),                    // byte + length?
    ];

    let firstByte = 0;
    let suffixIdx = 0;
    let found = false;

    function tryNext() {
      if (found || firstByte > 0xFF) {
        if (!found) console.log('\n  No single first-byte triggered a reply.');
        resolve(found);
        return;
      }

      const suffix = suffixes[suffixIdx];
      const payload = Buffer.concat([Buffer.from([firstByte]), suffix]);

      const sock = new net.Socket();
      sock.setTimeout(500); // short timeout — we're testing 256+ combos
      let gotReply = false;

      sock.on('connect', () => {
        sock.write(payload);
      });

      sock.on('data', (data) => {
        gotReply = true;
        found = true;
        console.log(`\n  🎉🎉🎉 DRONE REPLIED to first byte 0x${firstByte.toString(16).padStart(2,'0')}!`);
        console.log(`  Sent:     ${payload.toString('hex')}`);
        console.log(`  Reply:    ${data.toString('hex').substring(0, 120)}`);
        console.log(`  ASCII:    ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 120)}`);
        console.log(`  Length:   ${data.length} bytes`);
        sock.destroy();
      });

      sock.on('timeout', () => sock.destroy());
      sock.on('error', () => {});
      sock.on('close', () => {
        if (!gotReply) {
          // Move to next suffix, or next byte
          suffixIdx++;
          if (suffixIdx >= suffixes.length) {
            suffixIdx = 0;
            firstByte++;
          }
        }

        if (firstByte % 16 === 0 && suffixIdx === 0) {
          process.stdout.write(`\r  Testing first byte: 0x${firstByte.toString(16).padStart(2,'0')} (${((firstByte/256)*100).toFixed(0)}%)   `);
        }

        // Small delay so we don't overwhelm the drone
        setTimeout(tryNext, 20);
      });

      sock.connect(FOUND_PORT, DRONE);
    }

    tryNext();
  });
}

// ═══════════════════════════════════════════════════════════════
//  PHASE 3: TCP Connect THEN UDP
//  Theory: connecting to TCP 5007 "unlocks" a UDP channel.
//  The phone app might do: TCP connect → UDP commands.
// ═══════════════════════════════════════════════════════════════
function phase3_tcpThenUdp() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  PHASE 3: TCP CONNECT → THEN UDP PROBE                  ║');
    console.log('║  Theory: TCP 5007 is a "doorbell" that unlocks UDP       ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Step 1: Open and HOLD a TCP connection to 5007
    const tcpSock = new net.Socket();
    tcpSock.setTimeout(30000); // keep alive for 30 seconds

    tcpSock.on('connect', () => {
      console.log('  ✅ TCP 5007 connected and held open.');
      console.log('  Now firing UDP probes while TCP is alive...\n');

      // Step 2: While TCP is open, blast UDP probes
      const udpSock = dgram.createSocket('udp4');
      const PROBES = [
        Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
        Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
        Buffer.from([0xEF, 0x00, 0x04, 0x00]),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from([0x00]),
      ];

      // All likely UDP ports
      const udpPorts = [];
      for (let p = 5000; p <= 5020; p++) udpPorts.push(p);
      [8800, 7060, 8080, 40000, 50000, 8888, 9090, 5555, 80, 7000, 7070, 8000, 9000, 10000, 20000, 1234, 4567].forEach(p => udpPorts.push(p));

      udpSock.on('message', (msg, rinfo) => {
        if (rinfo.address === '127.0.0.1') return;
        console.log(`\n  🎉🎉🎉 UDP REPLY while TCP was open!`);
        console.log(`  From:  ${rinfo.address}:${rinfo.port}`);
        console.log(`  HEX:   ${msg.toString('hex').substring(0, 80)}`);
      });

      udpSock.bind(0, () => {
        udpSock.setBroadcast(true);
        let i = 0;
        const interval = setInterval(() => {
          if (i >= udpPorts.length) {
            clearInterval(interval);
            console.log('  Waiting 5 seconds for late UDP replies...');
            setTimeout(() => {
              udpSock.close();
              tcpSock.destroy();
              resolve();
            }, 5000);
            return;
          }

          const port = udpPorts[i++];
          PROBES.forEach(p => udpSock.send(p, 0, p.length, port, DRONE));
          process.stdout.write(`\r  UDP → ${DRONE}:${port}   `);
        }, 150);
      });
    });

    tcpSock.on('data', (data) => {
      console.log(`\n  📨 TCP REPLY while probing UDP!`);
      console.log(`  HEX: ${data.toString('hex').substring(0, 80)}`);
    });

    tcpSock.on('error', (err) => {
      console.log(`  TCP error: ${err.message}`);
      resolve();
    });

    tcpSock.connect(FOUND_PORT, DRONE);
  });
}

// ═══════════════════════════════════════════════════════════════
//  PHASE 4: Long listen on TCP 5007
//  Some drones only start streaming after 10-15 seconds.
//  We connect, send nothing, and wait a full 30 seconds.
// ═══════════════════════════════════════════════════════════════
function phase4_longListen() {
  return new Promise((resolve) => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  PHASE 4: LONG LISTEN on TCP 5007 (30 seconds)          ║');
    console.log('║  Some drones need time to warm up before streaming       ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const sock = new net.Socket();
    sock.setTimeout(35000);
    let totalBytes = 0;

    sock.on('connect', () => {
      console.log(`  [${ts()}] Connected. Waiting silently for 30 seconds...\n`);
    });

    sock.on('data', (data) => {
      totalBytes += data.length;
      console.log(`  [${ts()}] RECEIVED ${data.length} bytes (total: ${totalBytes})!`);
      console.log(`  HEX:   ${data.toString('hex').substring(0, 100)}`);
      console.log(`  ASCII: ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 100)}\n`);
    });

    sock.on('timeout', () => {
      if (totalBytes === 0) {
        console.log(`  [${ts()}] 30 seconds of silence. Port accepts connections but never talks.`);
      }
      sock.destroy();
      resolve();
    });

    sock.on('error', (err) => {
      console.log(`  Error: ${err.message}`);
      resolve();
    });

    sock.on('close', () => resolve());

    sock.connect(FOUND_PORT, DRONE);
  });
}

// ═══════════════════════════════════════════════════════════════
//  PHASE 5: Probe ALL found ports with the same interrogation
// ═══════════════════════════════════════════════════════════════
function phase5_probeAllPorts(ports) {
  return new Promise((resolve) => {
    if (ports.length <= 1) { resolve(); return; }

    const otherPorts = ports.filter(p => p !== FOUND_PORT);
    console.log(`\n╔══════════════════════════════════════════════════════════╗`);
    console.log(`║  PHASE 5: INTERROGATE OTHER OPEN PORTS                   ║`);
    console.log(`║  Found ports: ${ports.join(', ').padEnd(40)}║`);
    console.log(`╚══════════════════════════════════════════════════════════╝\n`);

    let idx = 0;

    function probeNext() {
      if (idx >= otherPorts.length) { resolve(); return; }

      const port = otherPorts[idx++];
      console.log(`  --- Probing TCP ${port} ---`);

      const sock = new net.Socket();
      sock.setTimeout(5000);
      let gotData = false;

      sock.on('connect', () => {
        console.log(`  Connected to ${port}. Listening...`);
      });

      sock.on('data', (data) => {
        gotData = true;
        console.log(`  📨 Port ${port} SPEAKS!`);
        console.log(`     HEX:   ${data.toString('hex').substring(0, 100)}`);
        console.log(`     ASCII: ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 100)}`);
      });

      sock.on('timeout', () => {
        if (!gotData) {
          // Try sending a probe
          sock.write(Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]));
          setTimeout(() => sock.destroy(), 2000);
        }
      });

      sock.on('error', (err) => console.log(`  Error on ${port}: ${err.message}`));
      sock.on('close', () => {
        if (!gotData) console.log(`  Port ${port}: silent.`);
        setTimeout(probeNext, 500);
      });

      sock.connect(port, DRONE);
    }

    probeNext();
  });
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║  🛸 DRONE CRACKER v3 — We found port 5007, now CRACK it  ║');
  console.log('╠' + '═'.repeat(58) + '╣');
  console.log('║  Phase 1: Full TCP scan (find ALL ports)                  ║');
  console.log('║  Phase 2: Binary protocol cracker (try every first byte)  ║');
  console.log('║  Phase 3: TCP doorbell → UDP unlock test                  ║');
  console.log('║  Phase 4: 30-second silent listen                         ║');
  console.log('║  Phase 5: Interrogate any other open ports                ║');
  console.log('║                                                           ║');
  console.log('║  ⏱️  ETA: ~25 minutes (stops early if cracked!)           ║');
  console.log('╚' + '═'.repeat(58) + '╝');

  // Phase 1: Find all ports
  const allPorts = await phase1_findAllPorts();
  if (!allPorts.includes(FOUND_PORT)) allPorts.push(FOUND_PORT);

  // Phase 2: Crack the protocol
  const cracked = await phase2_crackProtocol(allPorts);
  
  // Phase 3: TCP then UDP
  if (!cracked) await phase3_tcpThenUdp();

  // Phase 4: Long listen
  if (!cracked) await phase4_longListen();

  // Phase 5: Check other ports
  if (allPorts.length > 1) await phase5_probeAllPorts(allPorts);

  // Final
  console.log('\n' + '═'.repeat(60));
  console.log('  📊 FINAL RESULTS');
  console.log('═'.repeat(60));
  console.log(`  Open TCP ports found: ${allPorts.join(', ')}`);
  if (cracked) {
    console.log('  ✅ PROTOCOL CRACKED! See details above.');
  } else {
    console.log('  Protocol not cracked by byte sweep.');
    console.log('  The drone likely uses a multi-byte handshake header');
    console.log('  that can only be captured by sniffing the real app.');
    console.log('  → Install Wireshark + connect phone + run KY UFO app');
  }
  console.log('═'.repeat(60));
  process.exit();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
