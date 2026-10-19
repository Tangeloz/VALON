const dgram = require('dgram');
const readline = require('readline');

const DRONE_IP = '192.168.1.1';
const CTRL_PORT = 7099;
const sock = dgram.createSocket('udp4');

readline.emitKeypressEvents(process.stdin);
if (process.stdin.setRawMode) process.stdin.setRawMode(true);

// Stick values (center is 128)
let roll = 128, pitch = 128, thr = 128, yaw = 128;
let cmd = 0x00;
let speed = 0x02;

// Heartbeat count
let hbCount = 0;
let txCount = 0;

function buildPacket() {
    let buf = Buffer.alloc(21, 0);
    // Header
    buf[0] = 0x03; buf[1] = 0x66; buf[2] = 0x14;
    
    // Axes
    buf[3] = roll; buf[4] = pitch; buf[5] = thr; buf[6] = yaw;
    
    // Commands
    buf[7] = cmd; buf[8] = speed;
    
    // Bytes 9-18 are 0x00 padding
    
    // XOR Checksum (XOR of bytes 3 to 18)
    let chk = 0;
    for (let i = 3; i < 19; i++) {
        chk ^= buf[i];
    }
    buf[19] = chk;
    buf[20] = 0x99; // Footer
    
    return buf;
}

// 20Hz Control Loop
setInterval(() => {
    let pkt = buildPacket();
    sock.send(pkt, CTRL_PORT, DRONE_IP);
    txCount++;
    
    // Spring-back to center smoothly
    if (roll > 128) roll--; else if (roll < 128) roll++;
    if (pitch > 128) pitch--; else if (pitch < 128) pitch++;
    if (yaw > 128) yaw--; else if (yaw < 128) yaw++;
    if (thr > 128) thr--; else if (thr < 128) thr++;
    
    // Clear display and write status
    process.stdout.write('\x1Bc'); // clear screen
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  🛸 FLOW-UFO DRONE CONTROLLER (UDP 7099)                 ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  ROLL:  ${roll.toString().padStart(3)}  |  PITCH: ${pitch.toString().padStart(3)}                             ║`);
    console.log(`║  YAW:   ${yaw.toString().padStart(3)}  |  THR:   ${thr.toString().padStart(3)}                             ║`);
    console.log(`║  CMD:   0x${cmd.toString(16).padStart(2, '0')}                                            ║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  CONTROLS:                                               ║');
    console.log('║    W/S : Pitch (Forward/Backward)                        ║');
    console.log('║    A/D : Roll  (Left/Right)                              ║');
    console.log('║    Up/Dn : Throttle (Up/Down)                            ║');
    console.log('║    L/R   : Yaw (Spin Left/Right)                         ║');
    console.log('║                                                          ║');
    console.log('║    T : Takeoff / Land                                    ║');
    console.log('║    E : Emergency Stop (Motors Off)                       ║');
    console.log('║    C : Calibrate Gyro                                    ║');
    console.log('║    F : Flip (Press F, then quickly move a direction)     ║');
    console.log('║                                                          ║');
    console.log(`║  Status: Sent ${txCount} pkts | Heartbeats: ${hbCount}                 ║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('Press Ctrl+C to exit.');
}, 50);

// 1Hz Heartbeat Loop
setInterval(() => {
    sock.send(Buffer.from([0x01, 0x01]), CTRL_PORT, DRONE_IP);
    hbCount++;
}, 1000);

// Keyboard Input
process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') {
        process.exit();
    }
    
    const MOVE_AMT = 64; // How much to deflect the sticks
    
    if (key.name === 'w') pitch = 128 + MOVE_AMT;
    if (key.name === 's') pitch = 128 - MOVE_AMT;
    if (key.name === 'a') roll = 128 - MOVE_AMT;
    if (key.name === 'd') roll = 128 + MOVE_AMT;
    
    if (key.name === 'up') thr = 128 + MOVE_AMT;
    if (key.name === 'down') thr = 128 - MOVE_AMT;
    if (key.name === 'left') yaw = 128 - MOVE_AMT;
    if (key.name === 'right') yaw = 128 + MOVE_AMT;
    
    if (key.name === 't') {
        cmd = 0x01; // Takeoff / Land
        setTimeout(() => cmd = 0x00, 500);
    }
    if (key.name === 'e') {
        cmd = 0x02; // Emergency Stop
        setTimeout(() => cmd = 0x00, 500);
    }
    if (key.name === 'c') {
        cmd = 0x03; // Calibrate Gyro
        setTimeout(() => cmd = 0x00, 500);
    }
    if (key.name === 'f') {
        cmd = 0x05; // Flip Mode
        setTimeout(() => cmd = 0x00, 1000); // give 1 second to move joystick
    }
});
