const dgram = require('dgram');

const TARGET = '192.168.1.1';

// The absolute most common E99 / KY UFO UDP ports
const UDP_PORTS = [8800, 7060, 8080, 40000, 50000, 20000];

// The secret handshakes
const PROBES = [
  Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
  Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
  Buffer.from([0xEF, 0x00, 0x04, 0x00])
];

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   POLITE DRONE KNOCKER (Anti-Crash Version)          ║');
console.log('╚══════════════════════════════════════════════════════╝\n');

let found = false;
const sock = dgram.createSocket('udp4');

sock.on('message', (msg, rinfo) => {
  // Ignore our own loopback/broadcast echoes
  if (rinfo.address === '127.0.0.1' || rinfo.address.startsWith('169.')) return;
  
  if (!found) {
    console.log(`\n🎉 BINGO! The drone woke up on UDP Port ${rinfo.port} 🎉`);
    console.log(`IP: ${rinfo.address}`);
    console.log(`HEX: ${msg.toString('hex').substring(0, 40)}...`);
    console.log(`(Press Ctrl+C to exit)`);
    found = true;
  }
});

sock.bind(0, () => {
  sock.setBroadcast(true);
  
  console.log(`Knocking very slowly so the drone's cheap processor doesn't crash...`);
  
  let i = 0;
  
  // We use a slow interval (1 second between each knock) 
  // so the drone has plenty of time to process and reply.
  const interval = setInterval(() => {
    if (found) {
      clearInterval(interval);
      return;
    }
    
    if (i >= UDP_PORTS.length) {
      clearInterval(interval);
      console.log(`\nFinished knocking. Waiting 5 seconds for a late reply...`);
      setTimeout(() => {
        if (!found) console.log('❌ Still no reply. We might have to try the phone trick next.');
        process.exit();
      }, 5000);
      return;
    }

    const port = UDP_PORTS[i];
    console.log(`Knocking on port ${port}...`);
    
    PROBES.forEach(probe => {
      // Send directly to drone
      sock.send(probe, 0, probe.length, port, TARGET);
      // And shout to the whole network just in case
      sock.send(probe, 0, probe.length, port, '255.255.255.255');
    });
    
    i++;
  }, 1000); // 1000 ms = 1 full second pause between ports
});
