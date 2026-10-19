/*
 * DRONE FINDER — The Real Deal
 * 
 * WHAT WE KNOW FOR CERTAIN:
 *   - Drone SSID: FLOW-UFO-506853
 *   - Phone app "KY UFO" CAN control it → the Wi-Fi chip IS wired to flight board
 *   - ALL our previous scans hit 192.168.1.1 (TELUS router gateway)
 *   - We never confirmed the drone's actual IP after connecting to its WiFi
 *
 * WHAT THIS SCRIPT DOES:
 *   Phase 1: Discover — find what network we're actually on
 *   Phase 2: Listen  — passively listen for any traffic the drone broadcasts
 *   Phase 3: Knock   — try common drone ports on the REAL gateway
 *   Phase 4: Sweep   — slow full-range TCP scan if nothing else works
 */

const dgram = require('dgram');
const net = require('net');
const { exec } = require('child_process');
const os = require('os');

// ─── CONFIG ──────────────────────────────────────────────────
const TCP_TIMEOUT = 2000;
const BATCH_SIZE = 200;        // Small batches so we don't crash the drone
const BATCH_DELAY_MS = 1500;   // Pause between batches

// Common drone gateway IPs (we'll also auto-detect)
const KNOWN_DRONE_GATEWAYS = [
  '192.168.0.1',
  '172.16.10.1',
  '192.168.4.1',
  '10.0.0.1',
  '192.168.1.1',
  '192.168.10.1',
  '192.168.169.1',
  '192.168.100.1',
  '192.168.2.1',
];

// Known drone command/video ports
const KNOWN_DRONE_PORTS_TCP = [80, 554, 8080, 8554, 8800, 7060, 8888, 9090, 4567, 10001, 23, 21, 2345, 9060, 7080, 6789, 1234, 3000, 5000, 5555, 8000, 8081, 8181, 8443, 9000, 9999, 10000, 40000, 50000];
const KNOWN_DRONE_PORTS_UDP = [8800, 7060, 8080, 40000, 50000, 20000, 8888, 9090, 5555, 6789, 1234, 4567, 10001, 2345, 9060, 7080, 8000, 8001, 8002, 3000, 5000, 8554, 554, 10000, 9000, 9999, 7000, 7070, 7080, 6000, 6060, 4000, 4444, 3333, 2222, 1111, 11111, 22222, 33333, 44444, 55555, 60000, 60001, 60002];

// Known handshake probes for Chinese toy drones
const PROBES = [
  // KY UFO / cooingdv standard
  Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
  // Inverted variant
  Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
  // Short init
  Buffer.from([0xEF, 0x00, 0x04, 0x00]),
  // Heartbeat
  Buffer.from([0x63, 0x63, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]),
  // Another common init
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  // JJRC / Eachine hello
  Buffer.from([0xFF, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]),
  // "Connect me" patterns seen in decompiled APKs
  Buffer.from([0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40]),
  Buffer.from([0xAA, 0x02, 0x00, 0x00]),
  Buffer.from([0x26, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0xB9]),
  // Raw "are you there" single bytes
  Buffer.from([0x00]),
  Buffer.from([0xFF]),
  // WiFi cam init sequences
  Buffer.from('DDNS\r\n'),
  Buffer.from('GET /livestream HTTP/1.1\r\nHost: drone\r\n\r\n'),
];

const SEPARATOR = '═'.repeat(56);
const time = () => new Date().toLocaleTimeString();

// ─── PHASE 1: DISCOVER ──────────────────────────────────────
function discoverNetwork() {
  return new Promise((resolve) => {
    console.log(`\n╔${SEPARATOR}╗`);
    console.log(`║  PHASE 1: NETWORK DISCOVERY                            ║`);
    console.log(`╚${SEPARATOR}╝\n`);

    const interfaces = os.networkInterfaces();
    let myIP = null;
    let gateway = null;
    let networkName = null;

    // Find our WiFi IP
    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          // Prefer WiFi adapters
          const n = name.toLowerCase();
          if (n.includes('wi-fi') || n.includes('wifi') || n.includes('wlan') || n.includes('wireless')) {
            myIP = addr.address;
            networkName = name;
          }
          // Fallback to any non-internal
          if (!myIP) {
            myIP = addr.address;
            networkName = name;
          }
        }
      }
    }

    if (!myIP) {
      console.log('❌ No WiFi adapter found! Are you connected to the drone?');
      process.exit(1);
    }

    console.log(`   Your PC IP:       ${myIP}`);
    console.log(`   Adapter:          ${networkName}`);

    // Derive likely gateway from our IP (replace last octet with .1)
    const parts = myIP.split('.');
    parts[3] = '1';
    gateway = parts.join('.');
    console.log(`   Derived Gateway:  ${gateway}`);

    // Also get the real gateway from ipconfig
    exec('ipconfig', (err, stdout) => {
      const gwMatch = stdout.match(/Default Gateway[.\s]*:\s*([\d.]+)/);
      if (gwMatch && gwMatch[1]) {
        const realGW = gwMatch[1];
        console.log(`   System Gateway:   ${realGW}`);
        if (realGW !== gateway) {
          console.log(`   ⚠️  Gateway mismatch! Will test BOTH.`);
        }
        // Build final list of IPs to test
        const targets = new Set([gateway, realGW, ...KNOWN_DRONE_GATEWAYS]);
        resolve({ myIP, targets: Array.from(targets) });
      } else {
        const targets = new Set([gateway, ...KNOWN_DRONE_GATEWAYS]);
        resolve({ myIP, targets: Array.from(targets) });
      }
    });
  });
}

// ─── PHASE 2: PASSIVE LISTEN ────────────────────────────────
function passiveListen(durationSec) {
  return new Promise((resolve) => {
    console.log(`\n╔${SEPARATOR}╗`);
    console.log(`║  PHASE 2: PASSIVE LISTENING (${durationSec}s)                      ║`);
    console.log(`╚${SEPARATOR}╝`);
    console.log(`   Listening for ANY traffic the drone sends on its own...\n`);

    const heard = [];
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', (msg, rinfo) => {
      if (rinfo.address === '127.0.0.1') return; // ignore self
      const entry = `   📡 Heard from ${rinfo.address}:${rinfo.port} → ${msg.toString('hex').substring(0, 40)}`;
      console.log(entry);
      heard.push({ ip: rinfo.address, port: rinfo.port, hex: msg.toString('hex') });
    });

    sock.on('error', (err) => {
      console.log(`   (Listener error: ${err.message} — continuing anyway)`);
    });

    // Try to bind to port 0 (random) to catch broadcasts
    sock.bind(0, () => {
      sock.setBroadcast(true);
      // Also try to join multicast
      try { sock.addMembership('224.0.0.1'); } catch(e) {}
    });

    // Also open listeners on common drone video/command ports
    const extraSocks = [];
    [8800, 7060, 40000, 50000, 8080, 9090, 5555, 8888, 554].forEach(port => {
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('message', (msg, rinfo) => {
          if (rinfo.address === '127.0.0.1') return;
          console.log(`   📡 [port ${port}] Heard from ${rinfo.address}:${rinfo.port} → ${msg.toString('hex').substring(0, 40)}`);
          heard.push({ ip: rinfo.address, port: rinfo.port, hex: msg.toString('hex') });
        });
        s.on('error', () => {});
        s.bind(port);
        extraSocks.push(s);
      } catch(e) {}
    });

    setTimeout(() => {
      sock.close();
      extraSocks.forEach(s => { try { s.close(); } catch(e) {} });
      if (heard.length === 0) {
        console.log(`   🔇 Silence. The drone doesn't broadcast on its own.`);
      } else {
        console.log(`\n   Heard ${heard.length} packets! Unique sources:`);
        const uniqueIPs = [...new Set(heard.map(h => h.ip))];
        uniqueIPs.forEach(ip => console.log(`     → ${ip}`));
      }
      resolve(heard);
    }, durationSec * 1000);
  });
}

// ─── PHASE 3: SMART KNOCK ───────────────────────────────────
function smartKnock(targets) {
  return new Promise((resolve) => {
    console.log(`\n╔${SEPARATOR}╗`);
    console.log(`║  PHASE 3: SMART KNOCK (${targets.length} IPs × ${KNOWN_DRONE_PORTS_UDP.length} UDP ports)      ║`);
    console.log(`╚${SEPARATOR}╝`);
    console.log(`   Sending handshakes slowly to avoid crashing the drone...\n`);

    const results = [];
    const sock = dgram.createSocket('udp4');

    sock.on('message', (msg, rinfo) => {
      if (rinfo.address === '127.0.0.1') return;
      console.log(`\n   🎉 REPLY from ${rinfo.address}:${rinfo.port}!`);
      console.log(`   HEX: ${msg.toString('hex').substring(0, 60)}`);
      results.push({ ip: rinfo.address, port: rinfo.port, hex: msg.toString('hex') });
    });

    sock.bind(0, () => {
      sock.setBroadcast(true);

      // Build a queue: for each target, for each port, send each probe
      const queue = [];
      for (const ip of targets) {
        for (const port of KNOWN_DRONE_PORTS_UDP) {
          queue.push({ ip, port });
        }
      }

      let idx = 0;
      const interval = setInterval(() => {
        if (idx >= queue.length) {
          clearInterval(interval);
          console.log(`\n   Done knocking. Waiting 5 seconds for late replies...`);
          setTimeout(() => {
            sock.close();
            resolve(results);
          }, 5000);
          return;
        }

        const { ip, port } = queue[idx];
        // Send all probes to this ip:port
        PROBES.forEach(probe => {
          sock.send(probe, 0, probe.length, port, ip);
        });
        
        // Also broadcast
        PROBES.forEach(probe => {
          try { sock.send(probe, 0, probe.length, port, '255.255.255.255'); } catch(e) {}
        });

        // Progress every 10
        if (idx % 10 === 0) {
          process.stdout.write(`\r   Knocking... ${idx}/${queue.length} (${queue[idx].ip}:${queue[idx].port})   `);
        }

        idx++;
      }, 50); // 50ms between each knock — fast enough to finish, slow enough not to crash
    });
  });
}

// ─── PHASE 4: TARGETED TCP ──────────────────────────────────
function targetedTCP(targets) {
  return new Promise((resolve) => {
    console.log(`\n╔${SEPARATOR}╗`);
    console.log(`║  PHASE 4: TCP PORT SCAN (known drone ports only)       ║`);
    console.log(`╚${SEPARATOR}╝\n`);

    const results = [];
    const queue = [];

    for (const ip of targets) {
      for (const port of KNOWN_DRONE_PORTS_TCP) {
        queue.push({ ip, port });
      }
    }

    let idx = 0;
    let pending = 0;

    function launchBatch() {
      if (idx >= queue.length && pending === 0) {
        console.log(`\n   TCP scan complete. Found ${results.length} open ports.`);
        results.forEach(r => console.log(`     → ${r.ip}:${r.port}`));
        resolve(results);
        return;
      }

      while (pending < BATCH_SIZE && idx < queue.length) {
        const { ip, port } = queue[idx++];
        pending++;

        const sock = new net.Socket();
        sock.setTimeout(TCP_TIMEOUT);

        sock.on('connect', () => {
          console.log(`   🔥 TCP OPEN: ${ip}:${port}`);
          results.push({ ip, port });
          sock.destroy();
          pending--;
          launchBatch();
        });

        sock.on('timeout', () => { sock.destroy(); });
        sock.on('error', () => {});
        sock.on('close', () => {
          pending--;
          launchBatch();
        });

        sock.connect(port, ip);
      }

      if (idx % 100 === 0) {
        process.stdout.write(`\r   Scanning... ${idx}/${queue.length}   `);
      }
    }

    launchBatch();
  });
}

// ─── PHASE 5: PING SWEEP ────────────────────────────────────
function pingSweep(myIP) {
  return new Promise((resolve) => {
    console.log(`\n╔${SEPARATOR}╗`);
    console.log(`║  PHASE 5: ARP/PING SWEEP — Find ALL devices            ║`);
    console.log(`╚${SEPARATOR}╝`);

    const subnet = myIP.split('.').slice(0, 3).join('.');
    console.log(`   Pinging ${subnet}.1 through ${subnet}.20 ...`);

    const alive = [];
    let done = 0;
    const total = 20;

    for (let i = 1; i <= total; i++) {
      const ip = `${subnet}.${i}`;
      exec(`ping -n 1 -w 500 ${ip}`, (err, stdout) => {
        if (!err && stdout.includes('TTL=')) {
          console.log(`   ✅ ALIVE: ${ip}`);
          alive.push(ip);
        }
        done++;
        if (done === total) {
          console.log(`\n   Found ${alive.length} alive hosts: ${alive.join(', ')}`);
          resolve(alive);
        }
      });
    }
  });
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
  console.log('╔' + '═'.repeat(56) + '╗');
  console.log('║   🛸 DRONE FINDER — The Real Deal                      ║');
  console.log('║   Built from everything we learned                      ║');
  console.log('╠' + '═'.repeat(56) + '╣');
  console.log('║   ⚠️  CONNECT TO DRONE WIFI BEFORE RUNNING!             ║');
  console.log('║   SSID: FLOW-UFO-506853                                 ║');
  console.log('╚' + '═'.repeat(56) + '╝\n');

  // Phase 1: Find out where we actually are
  const { myIP, targets } = await discoverNetwork();

  // Phase 5 first (fast): Find alive hosts
  const aliveHosts = await pingSweep(myIP);
  
  // Merge alive hosts into targets (highest priority)
  const allTargets = [...new Set([...aliveHosts, ...targets])];
  console.log(`\n   📋 Will probe these IPs: ${allTargets.join(', ')}`);

  // Phase 2: Listen for 8 seconds
  const passiveResults = await passiveListen(8);

  // If passive listening found something, add those IPs
  if (passiveResults.length > 0) {
    passiveResults.forEach(r => {
      if (!allTargets.includes(r.ip)) allTargets.push(r.ip);
    });
  }

  // Phase 3: UDP knock on all targets
  const udpResults = await smartKnock(allTargets);

  // Phase 4: TCP scan on all targets
  const tcpResults = await targetedTCP(allTargets);

  // ─── FINAL REPORT ───────────────────────────────────────────
  console.log('\n' + '═'.repeat(58));
  console.log('  📊 FINAL REPORT');
  console.log('═'.repeat(58));
  console.log(`  Your IP:             ${myIP}`);
  console.log(`  Alive hosts:         ${aliveHosts.join(', ') || 'none'}`);
  console.log(`  Passive heard from:  ${passiveResults.length > 0 ? [...new Set(passiveResults.map(r => r.ip))].join(', ') : 'nothing'}`);
  console.log(`  UDP replies:         ${udpResults.length > 0 ? udpResults.map(r => `${r.ip}:${r.port}`).join(', ') : 'none'}`);
  console.log(`  TCP open ports:      ${tcpResults.length > 0 ? tcpResults.map(r => `${r.ip}:${r.port}`).join(', ') : 'none'}`);
  console.log('═'.repeat(58));

  if (udpResults.length === 0 && tcpResults.length === 0 && passiveResults.length === 0) {
    console.log('\n  ❌ THE DRONE IS COMPLETELY INVISIBLE.');
    console.log('  This means one of two things:');
    console.log('    1. You are NOT connected to the drone WiFi right now');
    console.log('       (check your WiFi — it should say FLOW-UFO-506853)');
    console.log('    2. The drone uses a protocol our PC WiFi cannot see');
    console.log('       (some ultra-cheap drones use raw WiFi frames)');
    console.log('\n  NEXT STEP: Run Wireshark (free) with the KY UFO phone app');
    console.log('  to capture what your phone actually sends to the drone.');
  } else {
    console.log('\n  ✅ WE FOUND SOMETHING! Use the info above to update');
    console.log('  your drone_controller.js with the correct IP and port.');
  }

  process.exit();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
