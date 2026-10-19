const dgram = require('dgram');

const TARGET = '192.168.1.1';

// The 3 most common "Wake Up / Control" packets for KY UFO drones
const PROBES = [
  Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]), // Standard KY UFO
  Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]), // Alternate KY UFO
  Buffer.from([0xEF, 0x00, 0x04, 0x00])                          // Generic Discovery
];

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   BRUTE-FORCE PORT KNOCKER — Target: ' + TARGET.padEnd(16) + '║');
console.log('╚══════════════════════════════════════════════════════╝\n');
console.log(`Firing packets at ALL 65,535 ports on the drone...`);

const sock = dgram.createSocket('udp4');
let received = false;

sock.on('message', (msg, rinfo) => {
  // Ignore our own loopback echoes
  if (rinfo.address === '127.0.0.1' || rinfo.address.startsWith('169.')) return;
  
  if (!received) {
    console.log(`\n🎉 ABSOLUTE BINGO! The drone replied from Port ${rinfo.port} 🎉`);
    console.log(`IP: ${rinfo.address}`);
    console.log(`HEX: ${msg.toString('hex').substring(0, 40)}...`);
    console.log(`(Press Ctrl+C to exit)`);
    received = true;
  }
});

sock.bind(0, () => {
  // Fire all probes at every single port from 1 to 65535
  let port = 1;
  const interval = setInterval(() => {
    // Send in batches of 1000 ports at a time so we don't overwhelm Windows
    for (let i = 0; i < 1000; i++) {
      if (port > 65535) {
        clearInterval(interval);
        console.log(`\nFinished firing at all ports. Waiting 5 seconds for any late replies...`);
        setTimeout(() => {
          if (!received) console.log('❌ Still no reply. The drone might use a totally different secret code.');
          process.exit();
        }, 5000);
        return;
      }
      
      PROBES.forEach(probe => {
        sock.send(probe, 0, probe.length, port, TARGET);
      });
      port++;
    }
  }, 10);
});
