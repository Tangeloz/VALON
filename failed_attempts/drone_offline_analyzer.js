const net = require('net');
const dgram = require('dgram');
const fs = require('fs');

const DRONE = '192.168.1.1';
const REPORT_FILE = 'drone_report.txt';

let report = " DRONE OFFLINE ANALYZER REPORT \n\n";

function log(msg) {
  console.log(msg);
  report += msg + '\n';
  fs.writeFileSync(REPORT_FILE, report);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function testTcp(port, name, payloads, waitMs = 2000) {
  log(`\n=== TEST TCP ${port} (${name}) ===`);
  for (let i = 0; i < payloads.length; i++) {
    await new Promise((resolve) => {
      const p = payloads[i];
      const sock = new net.Socket();
      sock.setTimeout(waitMs);
      let replied = false;

      log(`  -> Sending [${p.name}]: ${p.buf.toString('hex')}`);
      
      sock.on('connect', () => {
        sock.write(p.buf);
      });

      sock.on('data', (data) => {
        replied = true;
        log(`    <- REPLY (${data.length}B): ${data.toString('hex')}`);
        log(`    <- ASCII: ${data.toString('ascii').replace(/[^\x20-\x7e]/g, '.')}`);
        sock.destroy();
      });

      sock.on('timeout', () => {
        if (!replied) log(`    <- (Silence)`);
        sock.destroy();
      });

      sock.on('error', (err) => {
        log(`    <- ERROR: ${err.message}`);
        resolve();
      });

      sock.on('close', () => resolve());

      sock.connect(port, DRONE);
    });
    await sleep(500); // small delay between tests
  }
}

async function testRtsp(port) {
  log(`\n=== TEST RTSP ON TCP ${port} ===`);
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    
    sock.on('connect', () => {
      log(`  -> Sending RTSP OPTIONS`);
      sock.write(`OPTIONS rtsp://${DRONE}:${port}/ RTSP/1.0\r\nCSeq: 1\r\n\r\n`);
    });

    sock.on('data', (data) => {
      const text = data.toString('ascii');
      log(`    <- REPLY:\n${text.split('\n').map(l => '      ' + l).join('\n')}`);
      
      if (text.includes('Public:')) {
        // Find DESCRIBE path if available, or just try root
        log(`  -> Sending RTSP DESCRIBE`);
        sock.write(`DESCRIBE rtsp://${DRONE}:${port}/ RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n`);
      }
    });

    sock.on('timeout', () => sock.destroy());
    sock.on('error', (e) => log(`  <- ERROR: ${e.message}`));
    sock.on('close', () => resolve());

    sock.connect(port, DRONE);
  });
}

async function main() {
  log("Make sure you are connected to the drone's Wi-Fi (FLOW-UFO-...)!");
  
  const tcpPayloads = [
    { name: 'Hex 0101 (Heartbeat)', buf: Buffer.from([0x01, 0x01]) },
    { name: 'String 0101', buf: Buffer.from("0101") },
    { name: 'E58 Control (Neutral)', buf: Buffer.from([0x66, 0x80, 0x80, 0x00, 0x80, 0x00, 0x00, 0x99]) },
    { name: 'Cooingdv Control', buf: Buffer.from([0xCC, 0x80, 0x80, 0x00, 0x80, 0x00, 0x00, 0x33]) },
    { name: 'E58 Heartbeat', buf: Buffer.from([0x63, 0x63, 0x01, 0x00, 0x00, 0x00, 0x00]) },
    { name: 'Video Start 1', buf: Buffer.from([0xEF, 0x00, 0x04, 0x00]) },
    { name: 'Firmware 0xA0', buf: Buffer.from([0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) }
  ];

  await testTcp(5007, "Command Port", tcpPayloads, 2000);
  await testTcp(7070, "Video Port (Raw)", tcpPayloads, 2000);
  await testRtsp(7070);
  
  log("\n=== ALL TESTS COMPLETE ===");
  log(`Results saved to ${REPORT_FILE}. Copy/paste the contents of this file back to me!`);
}

main();
