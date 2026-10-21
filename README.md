# VALON
# FLOW-UFO — Vision-Stabilized Drone Control & Autonomous Follow Platform

> I lost the controller to a $10 garage-sale drone, so I taught my laptop to fly
> it instead — by probing its ports until I cracked the control protocol, then
> building a PC flight controller, a vision-based position-hold system, and an
> autonomous *follow-me* mode on top. Safety-first, no-contact by design.


---

## The origin story

I lost the controller to a $10 no-name garage-sale drone and was too stubborn to
toss it. I booted it up anyway, saw its `FLOW-UFO` Wi-Fi network appear on my
laptop, and decided I'd make it fly again from the PC — without the
(PC-incompatible) phone app it shipped with.

There was no documentation, so I found the protocol the hard way: **connecting my
PC directly to the drone's network and probing its open ports**, sending it test
packets to see what it would do. About 20 dead ends later — including
accidentally flooding its tiny chip until it froze, and chasing a decoy handshake
on port 5007 — I found its RTSP camera stream on **port 7070** and decoded its
**21-byte, XOR-checksummed UDP control packets on port 7099**. After that, my
laptop was the remote.

From there it became a testbed for control-theory and computer-vision ideas I'd
been learning — a way to meet the theory on real, noisy, laggy hardware instead
of a tidy simulator.

---

## What it does

- **Full manual control from a PC** over the reverse-engineered Wi-Fi protocol
  (roll / pitch / throttle / yaw, arm/takeoff/land, emergency stop, speed modes).
- **Live FPV video** with a DJI-style HUD: pitch ladder, compass, throttle/VS
  scales, stick overlays, signal status, flight timer.
- **Vision-based position hold** — the drone fights its own drift using optical
  flow from the camera, with no GPS or extra sensors.
- **Autonomous visual follow** — detects a subject and keeps them framed while
  holding a fixed standoff distance. **It follows and observes; it never
  approaches to contact.** (See [Responsible design](#responsible-design).)

---

## The interesting engineering

### 1. Protocol discovery by direct probing
No app traffic to capture (the app doesn't run on PC), so I reverse-engineered
the protocol by talking to the drone directly — port-scanning it, then firing
test packets and watching what responded. What fell out:

```
21-byte UDP control packet (port 7099):
[0x03 0x66 0x14] [roll][pitch][throttle][yaw][cmd][speed] [10× 0x00] [XOR checksum] [0x99]
```

- Sticks center at `0x80` (128), full deflection at the extremes.
- `cmd` is a bitfield for takeoff / land / emergency / flip / calibrate.
- Checksum is an XOR over the 16 payload bytes; footer is a fixed `0x99`.
- A 2-byte heartbeat (`0x01 0x01`) at 1 Hz keeps the link alive.
- Video is a separate **RTSP** stream on port **7070**.

### 2. Jitter-free control loop
Commands go out on a **fixed 20 Hz loop anchored to an absolute timeline**
(`next_tick += interval`, only resetting if it falls behind) so timing error
never accumulates. Sticks use an initial-burst-then-ramp response and **spring
back to center** on release, mimicking real RC feel.

### 3. Vision-based position hold (the control-theory core)
With no position sensor, the drone holds station by watching the world move:

- **Lucas-Kanade sparse optical flow** on Shi-Tomasi corner features.
- Flow is decomposed into **translation** (median vector — robust to outliers)
  and **rotation** (the residual *tangential* component around the frame center,
  converted to an angular rate). Separating those two is what makes the
  correction clean.
- A **PD controller** maps flow → gentle stick corrections: the P-term opposes
  current drift, the D-term brakes when drift is *accelerating* to prevent
  overshoot — which matters because the video feed has 200–500 ms of latency.
- Hardened against misbehavior: low authority clamp (~20% max), a noise-floor
  deadzone, feature-count gating (won't act on a weak estimate), and an instant
  **manual holdoff** that yields to the pilot the moment a stick moves.

### 4. Autonomous follow with dead-time compensation
The drone has no gimbal and only one camera, so tilting to move physically swings
the view — which naively makes the tracker oscillate. The follow pipeline fixes
that:

- **YOLO** object detection picks out the subject each frame.
- **Camera-attitude compensation** removes the apparent image shift caused by the
  drone's own pitch/roll before tracking error is computed (the pitch-coupling
  math that killed the oscillation).
- A **Smith predictor** estimates where the subject actually is *now*,
  compensating for the known video latency using a forward model of our own
  commands — so the controller isn't forever chasing a stale frame.
- A **state machine** (`SEARCH → ACQUIRE → TRACK → COAST`) governs behavior, with
  gain scheduling per state and a velocity-lead term for smooth pursuit.
- A **standoff controller** uses the subject's apparent size to *hold distance*:
  if the subject grows too large in frame, the drone backs off.

---

## Responsible design

This is a **follow-and-observe** platform, by deliberate design:

- There is **no contact / impact behavior** anywhere in the control logic. The
  autonomous pursuit's terminal state is "hold position on subject," never
  "approach subject."
- **Standoff is enforced** — a large subject bounding box commands *retreat*, so a
  misdetection can only ever make the drone back away, not lunge.
- **Authority is capped** and **manual override is instant** — the pilot can take
  control or hit emergency stop at any time.
- Intended for open space with a cooperative subject (follow-cam style), not
  around bystanders.

I treat the safety envelope as a first-class part of the control design, not an
afterthought.

---

## Architecture

```
            ┌──────────────── Wi-Fi ────────────────┐
  PC  ──UDP ctrl (20Hz)──►  Drone  ──RTSP video──►  PC
      ◄──── heartbeat ────         ◄── telemetry ───

  ┌───────────────────────── PC side ─────────────────────────┐
  │  Video ──► Optical-flow stabilizer ─┐                      │
  │        └─► YOLO detect ─► Smith predictor ─► Follow FSM ─┐ │
  │                                                          ▼ │
  │  Keyboard ─► Manual sticks ──► Command mixer ──► Ctrl loop │
  │                                 (manual + corrections)  │  │
  │                                                         ▼  │
  │                              20Hz packet builder ──► UDP   │
  └───────────────────────────────────────────────────────────┘
```

---

## Tech stack

- **Python**, **OpenCV** (video, optical flow, HUD rendering)
- **Ultralytics YOLO** (subject detection, GPU/FP16)
- **NumPy** for the flow math
- Raw **UDP sockets** + **RTSP** for the drone link
- Threading: separate control, heartbeat, and telemetry loops

---

## Running it

```bash
pip install opencv-python numpy ultralytics
```

1. Connect to the drone's Wi-Fi network.
2. Manual controller + stabilization:
   ```bash
   python drone_controller.py --debug
   ```
3. Autonomous follow (imports the controller as its protocol layer):
   ```bash
   python drone_tracker.py --source 0     # test on a webcam first, no drone
   ```

> **Test order that won't break hardware (or you):** validate on a webcam/video
> file with no drone connected → bench-test with props off and watch the stick
> readouts → only then fly, in open space, at 30% speed, with a hand on emergency
> stop.

### Controls (manual)
`WASD` roll/pitch · arrows throttle/yaw · `SPACE` hover · `C` arm · `T` takeoff ·
`L` land · `E` emergency stop · `B` toggle stabilization · `1/2/3` speed ·
`V` camera · `R` reconnect · `X` record · `Q` quit

---

## What I learned / hardest parts

- **Latency is the whole problem.** Half a second of video delay turns a naive
  tracker into an oscillator. Understanding *why* a Smith predictor and a
  derivative term tame that was the biggest conceptual payoff.
- **A camera that tilts when you move is its own enemy.** With no gimbal, every
  pitch command swings the horizon; subtracting that self-motion before tracking
  (pitch-coupling compensation) was the fix.
- **Robustness is most of the code.** The core control math is short; the bulk is
  guards — dead zones, feature gating, signal-loss handling, manual holdoff — the
  things that stop it doing something dumb on bad data.

---

## Roadmap

- Closed-loop altitude hold from optical-flow scale / barometer
- Replace dead-reckoned heading with real telemetry decode
- Automatic land-on-signal-loss failsafe
- Trajectory smoothing for the follow controller

---

## Disclaimer

Educational project built around a hobby drone on its own isolated Wi-Fi. Fly
responsibly, follow your local UAS regulations, and keep clear of people.
