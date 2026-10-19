/*
 * DRONE PORT 5007 INTERROGATOR
 * 
 * We found TCP port 5007 open on 192.168.1.1!
 * This script connects to it and tries to figure out what it is:
 *   - HTTP server? (video stream config page?)
 *   - Raw command port? (flight control?)
 *   - RTSP? (video stream?)
 *   - Something else entirely?
 *
 * It also tries UDP on 5007 and nearby ports (5000-5010)
 * in case the TCP port is just a "doorbell" and the real
 * command channel is UDP on the same or neighboring port.
 */

const net = require('net');
const dgram = require('dgram');

const DRONE = '192.168.1.1';
const PORT = 5007;

const PROBES = {
  'HTTP GET':        Buffer.from('GET / HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n'),
  'HTTP GET /':      Buffer.from('GET / HTTP/1.0\r\n\r\n'),
  'RTSP OPTIONS':    Buffer.from('OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n'),
  'RTSP DESCRIBE':   Buffer.from('DESCRIBE rtsp://192.168.1.1:5007/ RTSP/1.0\r\nCSeq: 2\r\n\r\n'),
  'KY UFO Init':     Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
  'KY UFO Alt':      Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
  'cooingdv Init':   Buffer.from([0xEF, 0x00, 0x04, 0x00]),
  'Heartbeat':       Buffer.from([0x63, 0x63, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]),
  'Null 4-byte':     Buffer.from([0x00, 0x00, 0x00, 0x00]),
  'JJRC hello':      Buffer.from([0xFF, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]),
  'Single 0x00':     Buffer.from([0x00]),
  'Single 0xFF':     Buffer.from([0xFF]),
  'Connect 0x28':    Buffer.from([0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40]),
  'AA init':         Buffer.from([0xAA, 0x02, 0x00, 0x00]),
  'Raw newline':     Buffer.from('\r\n'),
  'JSON hello':      Buffer.from('{"cmd":"connect"}\n'),
};

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  🔥 PORT 5007 INTERROGATOR                          ║');
console.log('║  Target: 192.168.1.1:5007                           ║');
console.log('╚══════════════════════════════════════════════════════╝\n');

// ─── TEST 1: Silent TCP Connect (just connect, say nothing, listen) ───
console.log('═══ TEST 1: Silent TCP connect — just listen ═══\n');

const silent = new net.Socket();
silent.setTimeout(5000);

silent.on('connect', () => {
  console.log('  ✅ Connected to TCP 5007!');
  console.log('  Waiting 3 seconds to see if drone talks first...\n');
});

silent.on('data', (data) => {
  console.log('  📨 DRONE SPOKE FIRST!');
  console.log(`  Bytes:  ${data.length}`);
  console.log(`  HEX:    ${data.toString('hex').substring(0, 120)}`);
  console.log(`  ASCII:  ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 120)}`);
  console.log(`  UTF8:   ${data.toString('utf8').replace(/[^\x20-\x7e]/g, '.').substring(0, 120)}`);
  console.log('');
});

silent.on('timeout', () => {
  console.log('  (Drone stayed silent for 5 seconds. Now we talk.)\n');
  silent.destroy();
  runProbeSequence();
});

silent.on('error', (err) => {
  console.log(`  ❌ Connection error: ${err.message}`);
  silent.destroy();
  runProbeSequence();
});

silent.connect(PORT, DRONE);

// ─── TEST 2: Send each probe one at a time ───
function runProbeSequence() {
  console.log('═══ TEST 2: Sending probes one at a time ═══\n');

  const probeNames = Object.keys(PROBES);
  let idx = 0;

  function nextProbe() {
    if (idx >= probeNames.length) {
      console.log('\n  All probes sent. Moving to UDP tests...\n');
      runUdpTests();
      return;
    }

    const name = probeNames[idx++];
    const data = PROBES[name];

    const sock = new net.Socket();
    sock.setTimeout(2000);
    let gotReply = false;

    sock.on('connect', () => {
      process.stdout.write(`  [${name}] → sending ${data.length} bytes... `);
      sock.write(data);
    });

    sock.on('data', (reply) => {
      gotReply = true;
      console.log(`\n  🎉 REPLIED to "${name}"!`);
      console.log(`     Bytes:  ${reply.length}`);
      console.log(`     HEX:    ${reply.toString('hex').substring(0, 100)}`);
      console.log(`     ASCII:  ${reply.toString('ascii').replace(/[^\x20-\x7e]/g, '.').substring(0, 100)}`);
    });

    sock.on('timeout', () => {
      if (!gotReply) process.stdout.write('no reply\n');
      sock.destroy();
    });

    sock.on('error', (err) => {
      if (!gotReply) process.stdout.write(`error: ${err.message}\n`);
    });

    sock.on('close', () => {
      setTimeout(nextProbe, 300); // small pause between probes
    });

    sock.connect(PORT, DRONE);
  }

  nextProbe();
}

// ─── TEST 3: UDP on port 5007 and neighbors ───
function runUdpTests() {
  console.log('═══ TEST 3: UDP probes on port 5007 and neighbors ═══\n');

  const UDP_PROBES = [
    Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
    Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
    Buffer.from([0xEF, 0x00, 0x04, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x00]),
  ];

  const udpPorts = [];
  for (let p = 5000; p <= 5020; p++) udpPorts.push(p);
  // Also try nearby common ports
  [8800, 7060, 8080, 40000, 50000].forEach(p => udpPorts.push(p));

  const sock = dgram.createSocket('udp4');

  sock.on('message', (msg, rinfo) => {
    if (rinfo.address === '127.0.0.1') return;
    console.log(`\n  🎉 UDP REPLY from ${rinfo.address}:${rinfo.port}!`);
    console.log(`     HEX: ${msg.toString('hex').substring(0, 80)}`);
  });

  sock.bind(5007, () => { // bind FROM 5007 (source port mirror)
    console.log('  Bound our UDP socket to port 5007 (mirror trick)');
    
    let i = 0;
    const interval = setInterval(() => {
      if (i >= udpPorts.length) {
        clearInterval(interval);
        console.log('\n  Waiting 5 seconds for late UDP replies...');
        setTimeout(() => {
          sock.close();
          printSummary();
        }, 5000);
        return;
      }

      const port = udpPorts[i++];
      UDP_PROBES.forEach(probe => {
        sock.send(probe, 0, probe.length, port, DRONE);
      });
      console.log(`  Sent UDP probes to ${DRONE}:${port}`);
    }, 200);
  });
}

function printSummary() {
  console.log('\n' + '═'.repeat(56));
  console.log('  DONE! Paste everything above so we can analyze it.');
  console.log('  Even "no reply" results tell us what the port ISN\'T.');
  console.log('═'.repeat(56));
  process.exit();
}
