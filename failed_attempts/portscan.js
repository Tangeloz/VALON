const net = require('net');
const dgram = require('dgram');
const { exec } = require('child_process');

const TARGET = '192.168.1.1';
const COMMON_PORTS = [21, 23, 80, 554, 7060, 8080, 8090, 8800, 8888, 9090, 20000, 50000];

const PROBES = [
  Buffer.from([0x66, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x99]),
  Buffer.from([0xcc, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x33]),
  Buffer.from([0xEF, 0x00, 0x04, 0x00]),
  Buffer.from([0x00, 0x01, 0x02, 0x03]),
  Buffer.from("hello")
];

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   ULTIMATE DRONE PROBER — Target: ' + TARGET.padEnd(19) + '║');
console.log('╚══════════════════════════════════════════════════════╝\n');

// 1. First, check if the drone even responds to a basic Ping
console.log('[1] Pinging the drone to see if it is alive...');
exec(`ping -n 2 -w 1000 ${TARGET}`, (error, stdout) => {
  if (stdout.includes('TTL=')) {
    console.log('   ✓ SUCCESS! The drone is connected and alive.\n');
  } else {
    console.log('   ❌ FAILED! The drone did not reply to a ping. Are you still connected to its WiFi?\n');
  }
  
  runTcpScan();
});

// 2. Slow TCP Scan of common ports
function runTcpScan() {
  console.log(`[2] Running a SLOW TCP scan (some drones are very slow to answer)...`);
  let tested = 0;
  let foundTCP = false;

  COMMON_PORTS.forEach(port => {
    const sock = new net.Socket();
    sock.setTimeout(2000); // 2 full seconds! The previous 200ms was probably too fast for a toy drone.

    sock.on('connect', () => {
      console.log(`   🔥 BINGO! TCP Port ${port} is OPEN!`);
      foundTCP = true;
      sock.destroy();
      checkDone();
    });

    sock.on('timeout', () => { sock.destroy(); checkDone(); });
    sock.on('error', () => { sock.destroy(); checkDone(); });

    sock.connect(port, TARGET);
  });

  function checkDone() {
    tested++;
    if (tested === COMMON_PORTS.length) {
      if (!foundTCP) console.log('   No TCP ports were open.');
      console.log();
      runUdpScan();
    }
  }
}

// 3. UDP Broadcast and Unicast
function runUdpScan() {
  console.log(`[3] Sending UDP wake-up packets (Broadcast + Unicast)...`);
  let foundUDP = false;

  COMMON_PORTS.forEach(port => {
    const sock = dgram.createSocket('udp4');
    
    sock.on('listening', () => {
      sock.setBroadcast(true); // Super important for some drones!
      PROBES.forEach(probe => {
        sock.send(probe, 0, probe.length, port, TARGET);
        sock.send(probe, 0, probe.length, port, '255.255.255.255');
      });
    });

    sock.on('message', (msg, rinfo) => {
      if (!foundUDP) {
        console.log(`\n   🎉 BINGO! UDP Port ${port} woke up and replied from ${rinfo.address}!`);
        console.log(`   HEX: ${msg.toString('hex').substring(0, 40)}...`);
        console.log(`   (Press Ctrl+C to exit)\n`);
        foundUDP = true;
      }
    });

    sock.on('error', () => {});
    sock.bind(port); 
  });
  
  console.log('   Waiting for replies... (If nothing happens in 10 seconds, press Ctrl+C)');
}
