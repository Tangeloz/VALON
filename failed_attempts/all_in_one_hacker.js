const net = require('net');
const dgram = require('dgram');
const { exec } = require('child_process');

const TARGET = '192.168.1.1';
const TOTAL_PORTS = 65535;
const BATCH_SIZE = 1000; // Scan 1000 ports at a time
const TCP_TIMEOUT = 1500; // 1.5 seconds

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   ALL-IN-ONE DRONE HACKER — Target: ' + TARGET.padEnd(16) + '║');
console.log('╚══════════════════════════════════════════════════════╝\n');
console.log('Thinking from scratch: If the drone ignored UDP, it almost certainly');
console.log('requires a TCP connection first (like knocking on a front door before');
console.log('it opens the window for the video feed).');
console.log('\nStarting full forensic scan of ALL 65,535 TCP ports...\n');

let openTcpPorts = [];
let currentPort = 1;

function scanBatch() {
  if (currentPort > TOTAL_PORTS) {
    console.log(`\n✅ TCP Scan complete! Found ${openTcpPorts.length} open ports.`);
    if (openTcpPorts.length > 0) {
      console.log(`Open Ports: ${openTcpPorts.join(', ')}`);
      probeOpenPorts(openTcpPorts);
    } else {
      console.log(`❌ Absolutely zero TCP ports are open. This drone is a ghost.`);
      console.log(`It might strictly use a hidden UDP sequence or broadcast only.`);
      process.exit();
    }
    return;
  }

  const batchEnd = Math.min(currentPort + BATCH_SIZE - 1, TOTAL_PORTS);
  let pending = batchEnd - currentPort + 1;
  
  process.stdout.write(`\rScanning ports ${currentPort} to ${batchEnd}... `);

  for (let p = currentPort; p <= batchEnd; p++) {
    const port = p;
    const sock = new net.Socket();
    sock.setTimeout(TCP_TIMEOUT);

    sock.on('connect', () => {
      process.stdout.write(`\n   🔥 BINGO! Found open TCP port: ${port}\n`);
      openTcpPorts.push(port);
      sock.destroy();
      checkDone();
    });

    sock.on('timeout', () => { sock.destroy(); checkDone(); });
    sock.on('error', () => { sock.destroy(); checkDone(); });

    sock.connect(port, TARGET);

    function checkDone() {
      pending--;
      if (pending === 0) {
        currentPort = batchEnd + 1;
        scanBatch(); // Start next batch
      }
    }
  }
}

// 2. Probe any found open TCP ports to see what they are running
function probeOpenPorts(ports) {
  console.log(`\nProbing the open ports to see if they talk HTTP or Drone Protocol...`);
  
  let pending = ports.length;
  
  ports.forEach(port => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    
    sock.on('connect', () => {
      // Send a standard HTTP GET request, and a generic wake-up
      sock.write("GET / HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n");
    });

    sock.on('data', (data) => {
      console.log(`\n[Port ${port} REPLIED VIA TCP!]`);
      console.log(`String: ${data.toString('utf8').replace(/\n/g, ' ')}`);
      console.log(`Hex:    ${data.toString('hex').substring(0, 60)}...`);
    });

    sock.on('close', () => { checkDone(); });
    sock.on('error', () => { checkDone(); });
    sock.on('timeout', () => { sock.destroy(); });

    sock.connect(port, TARGET);

    function checkDone() {
      pending--;
      if (pending === 0) {
        setTimeout(() => {
          console.log('\nProbe complete. If it spit back HTML/XML, it has a web server!');
          console.log('If it replied with hex, we found the command port!');
          process.exit();
        }, 1000);
      }
    }
  });
}

// Start the scan
scanBatch();
