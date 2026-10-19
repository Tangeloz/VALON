#!/usr/bin/env python3
"""
FLOW-UFO Drone Controller (Y-series / KY UFO protocol)
Protocol reverse-engineered from KY UFO app pcap captures.

Controls: WASD=roll/pitch, Arrows=throttle/yaw, T=takeoff, L=land,
          E=emergency, 1/2/3=speed, V=camera, R=reconnect, X=record,
          P=screenshot, B=toggle vision stabilization, Q=quit
"""

import cv2
import socket
import threading
import time
import os
import sys
import logging
import math
import numpy as np
from datetime import datetime

# ── Config ────────────────────────────────────────────────
DRONE_IP       = "192.168.1.1"
CTRL_PORT      = 7099
STREAM_URL     = "rtsp://192.168.1.1:7070/webcam"
OUTPUT_DIR     = os.path.expanduser("~/DroneCaptures")
LOG_FILE       = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug.log")
CTRL_HZ        = 20            # fixed 20Hz control loop (eliminates jitter)
HEARTBEAT_HZ   = 1             # heartbeat packets per second
CMD_DURATION   = 1.0           # seconds to hold takeoff/land commands
STICK_HOLD_MS  = 200           # ms to hold stick position after last keypress before spring-back
DISPLAY_W      = 960
DISPLAY_H      = 540

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Vision stabilization config ──────────────────────────
STAB_FLOW_SCALE    = 0.5       # downscale factor for optical flow (0.5 = half res)
STAB_MAX_FEATURES  = 120       # max features for Lucas-Kanade
STAB_QUALITY_LEVEL = 0.05      # Shi-Tomasi corner quality
STAB_MIN_DISTANCE  = 12        # min pixel distance between features
STAB_KP_LATERAL    = 0.8       # proportional gain — LOW to avoid overshoot with 200ms latency
STAB_KP_YAW        = 0.6       # proportional gain for yaw rotation
STAB_KD_LATERAL    = 1.2       # derivative (damping) gain — brakes when flow is accelerating
STAB_KD_YAW        = 0.8       # derivative (damping) gain for yaw
STAB_DEADZONE      = 1.0       # flow below this (px/frame) is ignored (noise floor)
STAB_MAX_AUTHORITY = 25        # max correction in stick units (~20% — gentle nudges only)
STAB_SMOOTHING     = 0.7       # exponential smoothing (higher = less jitter, slower response)
STAB_MIN_TRACKED   = 15        # minimum tracked features to trust the flow estimate
STAB_MANUAL_HOLDOFF = 0.6      # seconds to pause stabilization after any manual stick input

# ── Logging setup ────────────────────────────────────────
log = logging.getLogger("drone")
log.setLevel(logging.DEBUG)

_fh = logging.FileHandler(LOG_FILE, mode="w")
_fh.setLevel(logging.DEBUG)
_fh.setFormatter(logging.Formatter("%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s",
                                   datefmt="%H:%M:%S"))
log.addHandler(_fh)

_ch = logging.StreamHandler()
_ch.setLevel(logging.DEBUG if "--debug" in sys.argv else logging.WARNING)
_ch.setFormatter(logging.Formatter("  %(message)s"))
log.addHandler(_ch)

txlog = logging.getLogger("drone.tx")
txlog.setLevel(logging.DEBUG)
txlog.propagate = False
txlog.addHandler(_fh)

log.info("=== FLOW-UFO Drone Controller started ===")
log.info("Log file: %s", LOG_FILE)
log.info("Python %s, OpenCV %s", sys.version.split()[0], cv2.__version__)
log.info("Platform: %s", sys.platform)

# ── Arrow key codes (platform-dependent) ─────────────────
KEY_UP    = 63232
KEY_DOWN  = 63233
KEY_LEFT  = 63234
KEY_RIGHT = 63235
KEY_UP_LINUX    = 65362
KEY_DOWN_LINUX  = 65364
KEY_LEFT_LINUX  = 65361
KEY_RIGHT_LINUX = 65363

# ── Drone state ───────────────────────────────────────────
class DroneState:
    def __init__(self):
        self.roll     = 0x80
        self.pitch    = 0x80
        self.throttle = 0x80
        self.yaw      = 0x80
        self.cmd      = 0x00
        self.cmd_until = 0.0
        self.speed    = 0x02        # wire byte always 0x02
        self.speed_mode = 2         # 0=30%, 1=60%, 2=100% (client-side stick scaling)
        self.speed_scale = 1.0      # deflection multiplier: 0.30, 0.60, 1.00
        self.running  = True
        self.armed    = False
        self.flying   = False
        self.camera   = 1
        self.recording = False
        self.recorder  = None
        self.status_msg = "Ready - connect to FLOW-UFO WiFi"
        self.lock      = threading.Lock()
        self.roll_touch  = 0.0
        self.pitch_touch = 0.0
        self.yaw_touch   = 0.0
        self.thr_touch   = 0.0
        # Derived telemetry
        self.heading        = 0.0     # integrated yaw (degrees, 0-360)
        self.flight_start   = 0.0     # monotonic time when flight started
        self.flight_elapsed = 0.0     # accumulated seconds of flight
        # Signal tracking
        self.consec_drops   = 0
        self.last_good_frame = 0.0    # monotonic time of last successful frame
        self.signal_lost    = False
        self.reconnect_at   = 0.0       # monotonic time to auto-reconnect (0 = disabled)
        self.reconnect_retries = 0    # remaining auto-reconnect attempts
        # Vision stabilization
        self.stab_enabled   = False    # toggle with B key
        self.stab_active    = False    # True when flow is being computed and corrections applied
        self.stab_corr_roll = 0.0      # current correction in stick units (float, +=right)
        self.stab_corr_pitch = 0.0     # current correction in stick units (float, +=forward)
        self.stab_corr_yaw  = 0.0      # current correction in stick units (float, +=CW)
        self.stab_flow_x    = 0.0      # raw smoothed flow X (pixels/frame, for HUD display)
        self.stab_flow_y    = 0.0      # raw smoothed flow Y (pixels/frame, for HUD display)
        self.stab_flow_rot  = 0.0      # rotational component (deg/frame, for HUD display)
        self.stab_features  = 0        # number of tracked features (for HUD display)
        self.stab_manual_until = 0.0   # monotonic time until which manual holdoff is active
        self.stab_prev_dx   = 0.0      # previous frame flow (for derivative/damping)
        self.stab_prev_dy   = 0.0
        self.stab_prev_rot  = 0.0
        # Counters
        self.tx_count  = 0
        self.rx_count  = 0
        self.hb_count  = 0
        self.key_count = 0

state = DroneState()
sock  = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# ── Protocol helpers ──────────────────────────────────────
def build_ctrl(roll, pitch, throttle, yaw, cmd, speed):
    pkt = [0x03, 0x66, 0x14, roll, pitch, throttle, yaw, cmd, speed]
    pkt += [0x00] * 10
    chk = 0
    for b in pkt[3:19]:
        chk ^= b
    pkt.append(chk)
    pkt.append(0x99)
    return bytes(pkt)

def _safe_send(data):
    """Send UDP datagram, silently ignore network-unreachable errors."""
    try:
        sock.sendto(data, (DRONE_IP, CTRL_PORT))
        return True
    except OSError:
        return False

def send_heartbeat():
    _safe_send(bytes([0x01, 0x01]))
    state.hb_count += 1
    txlog.debug("HB  tx #%d", state.hb_count)

def send_ctrl():
    now = time.monotonic()
    with state.lock:
        if state.cmd != 0x00 and now >= state.cmd_until:
            log.info("CMD 0x%02x expired, clearing to 0x00", state.cmd)
            state.cmd = 0x00
        # Combine manual stick + stabilization correction
        man_roll  = state.roll - 0x80     # manual deflection from center (-128..+127)
        man_pitch = state.pitch - 0x80
        man_yaw   = state.yaw - 0x80
        man_thr   = state.throttle - 0x80

        # Add stabilization corrections (only if enabled, active, flying, has video, and not in manual holdoff)
        if (state.stab_enabled and state.stab_active and state.armed
                and not state.signal_lost
                and now >= state.stab_manual_until):
            total_roll  = man_roll  + state.stab_corr_roll
            total_pitch = man_pitch + state.stab_corr_pitch
            total_yaw   = man_yaw   + state.stab_corr_yaw
        else:
            total_roll  = man_roll
            total_pitch = man_pitch
            total_yaw   = man_yaw

        # Apply speed scaling to stick values (client-side deflection limit)
        sc = state.speed_scale
        r = int(max(0, min(255, 0x80 + total_roll  * sc)))
        p = int(max(0, min(255, 0x80 + total_pitch * sc)))
        t = int(max(0, min(255, 0x80 + man_thr     * sc)))
        y = int(max(0, min(255, 0x80 + total_yaw   * sc)))
        cmd, spd = state.cmd, state.speed
        pkt = build_ctrl(r, p, t, y, cmd, spd)
    _safe_send(pkt)
    state.tx_count += 1
    if state.stab_enabled and state.tx_count % 20 == 0:
        holdoff = "MANUAL" if now < state.stab_manual_until else "ACTIVE" if state.stab_active else "WAIT"
        txlog.debug("TX  #%05d  R=%3d P=%3d T=%3d Y=%3d cmd=0x%02x spd=0x%02x  STAB[%s flow=(%.1f,%.1f,%.2f) corr=(%.0f,%.0f,%.0f) feat=%d]  raw=%s",
                    state.tx_count, r, p, t, y, cmd, spd, holdoff,
                    state.stab_flow_x, state.stab_flow_y, state.stab_flow_rot,
                    state.stab_corr_roll, state.stab_corr_pitch, state.stab_corr_yaw,
                    state.stab_features, pkt.hex())
    else:
        txlog.debug("TX  #%05d  R=%3d P=%3d T=%3d Y=%3d cmd=0x%02x spd=0x%02x  raw=%s",
                    state.tx_count, r, p, t, y, cmd, spd, pkt.hex())

def switch_camera(n):
    pkt = bytes([0x06, n])
    _safe_send(pkt)
    stabilizer.reset()  # view changed completely, reset optical flow
    with state.lock:
        state.camera = n
        state.status_msg = f"Camera {n} — reconnecting..."
        state.reconnect_at = time.monotonic() + 1.5  # auto-reconnect after drone restarts RTSP
        state.reconnect_retries = 5                   # retry up to 5 times if first attempt fails
    log.info("CAM switch to %d  raw=%s (auto-reconnect scheduled)", n, pkt.hex())

def set_timed_cmd(cmd, duration=CMD_DURATION):
    state.cmd = cmd
    state.cmd_until = time.monotonic() + duration
    log.info("CMD set 0x%02x for %.1fs (expires at +%.3f)", cmd, duration, state.cmd_until)

# ── Control loop thread (fixed 20Hz with absolute timestamp anchoring) ─
def ctrl_loop():
    log.info("Control loop started: fixed %d Hz", CTRL_HZ)
    interval = 1.0 / CTRL_HZ
    next_tick = time.monotonic()
    while state.running:
        if state.armed:
            now = time.monotonic()
            hold_sec = STICK_HOLD_MS / 1000.0
            with state.lock:
                # Spring-back for all sticks (including throttle)
                if now - state.roll_touch > hold_sec:
                    state.roll = _ease(state.roll)
                if now - state.pitch_touch > hold_sec:
                    state.pitch = _ease(state.pitch)
                if now - state.yaw_touch > hold_sec:
                    state.yaw = _ease(state.yaw)
                if now - state.thr_touch > hold_sec:
                    state.throttle = _ease(state.throttle)
                # Heading integration from yaw
                yaw_norm = (state.yaw - 0x80) / 128.0  # -1..+1
                state.heading = (state.heading + yaw_norm * 200.0 * interval) % 360
                # Flight timer
                if state.flying and state.flight_start > 0:
                    state.flight_elapsed = now - state.flight_start
            send_ctrl()
        next_tick += interval
        sleep_dur = next_tick - time.monotonic()
        if sleep_dur > 0:
            time.sleep(sleep_dur)
        else:
            next_tick = time.monotonic()  # reset if fell behind
    log.info("Control loop stopped. Total TX: %d", state.tx_count)

def _ease(v):
    diff = 0x80 - v
    return v + int(diff * 0.50) if abs(diff) > 2 else 0x80

# ── Heartbeat thread (1Hz) ───────────────────────────────
def heartbeat_loop():
    interval = 1.0 / HEARTBEAT_HZ
    log.info("Heartbeat loop started at %d Hz", HEARTBEAT_HZ)
    while state.running:
        send_heartbeat()
        time.sleep(interval)
    log.info("Heartbeat loop stopped. Total HB: %d", state.hb_count)

# ── Telemetry listener thread ────────────────────────────
def telemetry_loop():
    sock.settimeout(1.0)
    log.info("Telemetry listener started on sock (will recv from drone)")
    while state.running:
        try:
            data, addr = sock.recvfrom(256)
            state.rx_count += 1
            log.debug("RX  #%05d from %s:%d  len=%d  raw=%s",
                      state.rx_count, addr[0], addr[1], len(data), data.hex())
        except (socket.timeout, OSError):
            pass
    log.info("Telemetry listener stopped. Total RX: %d", state.rx_count)

# ── Vision-based Stabilization Engine ────────────────────
class OpticalFlowStabilizer:
    """
    Computes optical flow between consecutive frames and decomposes it into
    translational (drift) and rotational (yaw) components.

    Uses Lucas-Kanade sparse optical flow on Shi-Tomasi features.
    Translation = median of all flow vectors (robust to outliers).
    Rotation = median tangential component around frame center.
    """

    def __init__(self):
        self.prev_gray = None
        self.prev_pts = None
        # Smoothed output (exponential moving average)
        self.smooth_dx = 0.0
        self.smooth_dy = 0.0
        self.smooth_rot = 0.0

        # Lucas-Kanade parameters (tuned for drone footage)
        self.lk_params = dict(
            winSize=(21, 21),        # search window — larger handles fast motion better
            maxLevel=3,              # pyramid levels — 3 is good for 320x192
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03),
        )
        # Shi-Tomasi feature detection parameters
        self.feature_params = dict(
            maxCorners=STAB_MAX_FEATURES,
            qualityLevel=STAB_QUALITY_LEVEL,
            minDistance=STAB_MIN_DISTANCE,
            blockSize=7,
        )

    def reset(self):
        """Reset state (call when stabilization toggled off/on or camera changes)."""
        self.prev_gray = None
        self.prev_pts = None
        self.smooth_dx = 0.0
        self.smooth_dy = 0.0
        self.smooth_rot = 0.0

    def process(self, frame):
        """
        Process a new frame. Returns (drift_x, drift_y, yaw_rate, n_features).

        drift_x: horizontal drift in pixels/frame (positive = image moved right = drone moved left)
        drift_y: vertical drift in pixels/frame (positive = image moved down = drone moved backward)
        yaw_rate: rotational flow in degrees/frame (positive = CW rotation of image = drone rotating CCW)
        n_features: number of successfully tracked features

        Returns (0, 0, 0, 0) if flow cannot be computed (first frame, too few features, etc.)
        """
        # Downscale and convert to grayscale
        h, w = frame.shape[:2]
        small_w = int(w * STAB_FLOW_SCALE)
        small_h = int(h * STAB_FLOW_SCALE)
        small = cv2.resize(frame, (small_w, small_h), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

        # First frame — just detect features and return
        if self.prev_gray is None:
            self.prev_gray = gray
            self.prev_pts = cv2.goodFeaturesToTrack(gray, **self.feature_params)
            n = len(self.prev_pts) if self.prev_pts is not None else 0
            log.info("STAB: initialized with %d features on %dx%d", n, small_w, small_h)
            return 0.0, 0.0, 0.0, n

        # No features to track — re-detect
        if self.prev_pts is None or len(self.prev_pts) < STAB_MIN_TRACKED:
            self.prev_pts = cv2.goodFeaturesToTrack(gray, **self.feature_params)
            if self.prev_pts is None or len(self.prev_pts) < STAB_MIN_TRACKED:
                self.prev_gray = gray
                return 0.0, 0.0, 0.0, 0

        # Compute optical flow (Lucas-Kanade)
        next_pts, status, err = cv2.calcOpticalFlowPyrLK(
            self.prev_gray, gray, self.prev_pts, None, **self.lk_params
        )

        if next_pts is None or status is None:
            self.prev_gray = gray
            self.prev_pts = None
            return 0.0, 0.0, 0.0, 0

        # Filter to only good matches
        good_mask = status.ravel() == 1
        if np.sum(good_mask) < STAB_MIN_TRACKED:
            # Too few matched — re-detect features next frame
            self.prev_gray = gray
            self.prev_pts = cv2.goodFeaturesToTrack(gray, **self.feature_params)
            return 0.0, 0.0, 0.0, int(np.sum(good_mask))

        old_pts = self.prev_pts[good_mask].reshape(-1, 2)
        new_pts = next_pts[good_mask].reshape(-1, 2)
        n_tracked = len(old_pts)

        # Compute per-point flow vectors
        flow = new_pts - old_pts  # shape (N, 2), each row is (dx, dy)

        # ── Decompose into translation and rotation ──
        # Translation = median flow (robust to outlier features and depth variation)
        median_dx = float(np.median(flow[:, 0]))
        median_dy = float(np.median(flow[:, 1]))

        # Rotation = tangential component around image center
        # For each point, compute the tangential flow and compare to observed flow
        cx, cy = small_w / 2.0, small_h / 2.0

        # Vector from center to each old point
        rx = old_pts[:, 0] - cx
        ry = old_pts[:, 1] - cy
        r_mag = np.sqrt(rx**2 + ry**2)

        # Avoid division by zero for points near center
        far_mask = r_mag > 10.0
        if np.sum(far_mask) >= 5:
            # Subtract translation to isolate rotational flow
            rot_flow_x = flow[far_mask, 0] - median_dx
            rot_flow_y = flow[far_mask, 1] - median_dy

            # Tangential direction at each point (perpendicular to radius, CCW)
            r_far = r_mag[far_mask]
            tan_x = -ry[far_mask] / r_far  # unit tangent X
            tan_y = rx[far_mask] / r_far    # unit tangent Y

            # Project residual flow onto tangential direction
            tan_component = rot_flow_x * tan_x + rot_flow_y * tan_y

            # Convert to angular velocity: omega = v_tangential / r
            omega = tan_component / r_far
            median_omega = float(np.median(omega))

            # Convert radians/frame to degrees/frame
            yaw_rate = math.degrees(median_omega)
        else:
            yaw_rate = 0.0

        # ── Exponential smoothing ──
        alpha = 1.0 - STAB_SMOOTHING
        self.smooth_dx = self.smooth_dx * STAB_SMOOTHING + median_dx * alpha
        self.smooth_dy = self.smooth_dy * STAB_SMOOTHING + median_dy * alpha
        self.smooth_rot = self.smooth_rot * STAB_SMOOTHING + yaw_rate * alpha

        # ── Update state for next frame ──
        self.prev_gray = gray

        # Re-detect features periodically to maintain good tracking
        # If we lost more than 40% of features, re-detect
        if n_tracked < STAB_MAX_FEATURES * 0.6:
            self.prev_pts = cv2.goodFeaturesToTrack(gray, **self.feature_params)
        else:
            self.prev_pts = new_pts.reshape(-1, 1, 2)

        return self.smooth_dx, self.smooth_dy, self.smooth_rot, n_tracked

# Global stabilizer instance
stabilizer = OpticalFlowStabilizer()

def compute_stabilization(frame):
    """
    Run optical flow on the frame and compute stick corrections.
    Uses PD controller: P counters current drift, D damps acceleration (prevents overshoot).
    Updates state.stab_corr_roll/pitch/yaw.
    Called from the main loop on each video frame.
    """
    dx, dy, rot, n_features = stabilizer.process(frame)

    with state.lock:
        state.stab_features = n_features
        state.stab_flow_x = dx
        state.stab_flow_y = dy
        state.stab_flow_rot = rot

        if n_features < STAB_MIN_TRACKED:
            # Not enough features — zero out corrections, don't apply garbage
            state.stab_active = False
            state.stab_corr_roll = 0.0
            state.stab_corr_pitch = 0.0
            state.stab_corr_yaw = 0.0
            state.stab_prev_dx = 0.0
            state.stab_prev_dy = 0.0
            state.stab_prev_rot = 0.0
            return

        # If manual holdoff is active (user was just flying), don't apply corrections
        # AND reset the flow accumulator so stale momentum doesn't cause "going back"
        if time.monotonic() < state.stab_manual_until:
            state.stab_active = False
            state.stab_corr_roll = 0.0
            state.stab_corr_pitch = 0.0
            state.stab_corr_yaw = 0.0
            # Reset flow accumulator — prevents accumulated drift from fast manual
            # movement being applied as correction when holdoff expires
            stabilizer.smooth_dx = 0.0
            stabilizer.smooth_dy = 0.0
            stabilizer.smooth_rot = 0.0
            state.stab_prev_dx = 0.0
            state.stab_prev_dy = 0.0
            state.stab_prev_rot = 0.0
            return

        state.stab_active = True

        # ── Apply dead zone ──
        # Flow below the noise floor is ignored to prevent jitter
        eff_dx = dx if abs(dx) > STAB_DEADZONE else 0.0
        eff_dy = dy if abs(dy) > STAB_DEADZONE else 0.0
        eff_rot = rot if abs(rot) > STAB_DEADZONE * 0.3 else 0.0

        # ── Derivative (damping) term ──
        # d_dx is how fast the flow is CHANGING. If the drone is accelerating
        # in one direction, the derivative is positive and we brake harder.
        # If the drone is decelerating (correction is working), derivative opposes
        # the P-term, preventing overshoot.
        d_dx = eff_dx - state.stab_prev_dx
        d_dy = eff_dy - state.stab_prev_dy
        d_rot = eff_rot - state.stab_prev_rot

        state.stab_prev_dx = eff_dx
        state.stab_prev_dy = eff_dy
        state.stab_prev_rot = eff_rot

        # ── PD controller: flow → stick correction ──
        # Camera points DOWN. Drone protocol: roll>0x80=right, pitch>0x80=forward, yaw>0x80=CW
        #
        # P-term: counters current drift (proportional to flow magnitude)
        # D-term: damps oscillation (proportional to flow acceleration)
        #   - If flow is increasing (drone accelerating away) → D adds to correction
        #   - If flow is decreasing (drone slowing down from correction) → D reduces correction
        #   This is what prevents overshoot.

        corr_roll  = eff_dx  * STAB_KP_LATERAL + d_dx  * STAB_KD_LATERAL
        corr_pitch = eff_dy  * STAB_KP_LATERAL + d_dy  * STAB_KD_LATERAL
        corr_yaw   = eff_rot * STAB_KP_YAW     + d_rot * STAB_KD_YAW

        # ── Clamp to maximum authority ──
        corr_roll  = max(-STAB_MAX_AUTHORITY, min(STAB_MAX_AUTHORITY, corr_roll))
        corr_pitch = max(-STAB_MAX_AUTHORITY, min(STAB_MAX_AUTHORITY, corr_pitch))
        corr_yaw   = max(-STAB_MAX_AUTHORITY, min(STAB_MAX_AUTHORITY, corr_yaw))

        state.stab_corr_roll = corr_roll
        state.stab_corr_pitch = corr_pitch
        state.stab_corr_yaw = corr_yaw

# ── HUD Colors (BGR) ────────────────────────────────────
C_GREEN     = (80, 220, 80)
C_BGREEN    = (80, 220, 120)
C_RED       = (50, 50, 220)
C_WHITE     = (230, 230, 230)
C_GRAY      = (140, 140, 140)
C_DGRAY     = (90, 90, 90)
C_CYAN      = (200, 200, 50)
C_YELLOW    = (50, 200, 220)
C_HUD_GREEN = (100, 255, 100)
C_HUD_DIM   = (60, 160, 60)
FONT        = cv2.FONT_HERSHEY_SIMPLEX

# ── HUD sub-components (DJI-style) ──────────────────────
def _semi_rect(frame, x1, y1, x2, y2, color, alpha):
    """Draw a semi-transparent filled rectangle."""
    ry1, ry2 = max(0, y1), min(frame.shape[0], y2)
    rx1, rx2 = max(0, x1), min(frame.shape[1], x2)
    if ry2 <= ry1 or rx2 <= rx1:
        return
    overlay = frame[ry1:ry2, rx1:rx2].copy()
    cv2.rectangle(frame, (rx1, ry1), (rx2, ry2), color, -1)
    frame[ry1:ry2, rx1:rx2] = cv2.addWeighted(frame[ry1:ry2, rx1:rx2], alpha, overlay, 1 - alpha, 0)

def draw_status_bar(frame, w, fps, flight_secs):
    """Top status bar — DJI style."""
    bar_h = 36
    _semi_rect(frame, 0, 0, w, bar_h, (0, 0, 0), 0.55)

    y = 25
    x = 12

    if state.recording:
        if int(time.time() * 2) % 2:
            cv2.circle(frame, (x + 5, y - 5), 5, C_RED, -1, cv2.LINE_AA)
        cv2.putText(frame, "REC", (x + 14, y), FONT, 0.42, C_RED, 1, cv2.LINE_AA)
        x += 55

    if state.signal_lost:
        cv2.putText(frame, "NO SIGNAL", (x, y), FONT, 0.42, C_RED, 2, cv2.LINE_AA)
        x += 100

    # Armed state
    if state.armed:
        cv2.putText(frame, "ARMED", (x, y), FONT, 0.42, C_GREEN, 1, cv2.LINE_AA)
    else:
        cv2.putText(frame, "DISARMED", (x, y), FONT, 0.42, C_DGRAY, 1, cv2.LINE_AA)

    # Status message (smaller, after armed)
    cv2.putText(frame, state.status_msg, (x + 90, y), FONT, 0.38, C_GRAY, 1, cv2.LINE_AA)

    # Right side
    rx = w - 10
    cv2.putText(frame, f"{fps:.0f}fps", (rx - 48, y), FONT, 0.38, C_DGRAY, 1, cv2.LINE_AA)
    rx -= 58

    mins = int(flight_secs) // 60
    secs = int(flight_secs) % 60
    t_color = C_WHITE if state.flying else C_DGRAY
    cv2.putText(frame, f"T+{mins:02d}:{secs:02d}", (rx - 65, y), FONT, 0.42, t_color, 1, cv2.LINE_AA)
    rx -= 75

    cv2.putText(frame, f"CAM{state.camera}", (rx - 42, y), FONT, 0.38, C_CYAN, 1, cv2.LINE_AA)
    rx -= 52

    spd_labels = ["30%", "60%", "100%"]
    spd_txt = spd_labels[state.speed_mode]
    spd_color = C_YELLOW if state.speed_mode == 2 else C_CYAN
    cv2.putText(frame, spd_txt, (rx - 42, y), FONT, 0.38, spd_color, 1, cv2.LINE_AA)
    rx -= 52

    # Stabilization indicator
    if state.stab_enabled:
        if time.monotonic() < state.stab_manual_until:
            stab_txt = "STAB(manual)"
            stab_color = C_CYAN
        elif state.stab_active:
            stab_txt = f"STAB({state.stab_features})"
            stab_color = C_GREEN
        else:
            stab_txt = "STAB(?)"
            stab_color = C_YELLOW
    else:
        stab_txt = "STAB"
        stab_color = C_DGRAY
    cv2.putText(frame, stab_txt, (rx - 70, y), FONT, 0.38, stab_color, 1, cv2.LINE_AA)

def draw_stab_overlay(frame, w, h):
    """Draw stabilization flow vector and correction indicators."""
    if not state.stab_enabled:
        return

    cx, cy = w // 2, h // 2

    # Draw flow vector from center (scaled up for visibility)
    flow_scale = 15.0  # pixels/frame → display pixels
    fx = int(state.stab_flow_x * flow_scale)
    fy = int(state.stab_flow_y * flow_scale)

    # Flow vector (what the image is doing — cyan)
    if abs(fx) > 2 or abs(fy) > 2:
        cv2.arrowedLine(frame, (cx, cy), (cx + fx, cy + fy),
                        C_CYAN, 2, cv2.LINE_AA, tipLength=0.3)

    # Correction vector (what we're applying — green, opposite direction)
    corr_scale = 1.5
    crx = int(-state.stab_corr_roll * corr_scale)
    cry = int(state.stab_corr_pitch * corr_scale)
    if abs(crx) > 1 or abs(cry) > 1:
        cv2.arrowedLine(frame, (cx, cy), (cx + crx, cy + cry),
                        C_GREEN, 1, cv2.LINE_AA, tipLength=0.3)

    # Yaw rotation indicator (arc at bottom of compass area)
    rot_vis = state.stab_flow_rot * 20.0  # scale for visibility
    if abs(rot_vis) > 1:
        rot_color = C_CYAN
        yaw_x = w // 2 + int(rot_vis)
        cv2.arrowedLine(frame, (w // 2, h - 130), (yaw_x, h - 130),
                        rot_color, 1, cv2.LINE_AA, tipLength=0.4)

def draw_pitch_ladder(frame, cx, cy, roll_val, pitch_val):
    """DJI-style pitch ladder with bracket ends, wide lines, center gap."""
    h, w = frame.shape[:2]
    clip_w, clip_h = 600, 260
    clip_x1, clip_y1 = max(0, cx - clip_w // 2), max(0, cy - clip_h // 2)

    roll_deg = (roll_val - 0x80) / 128.0 * 45.0
    pitch_px = (pitch_val - 0x80) / 128.0 * 70.0

    roll_rad = math.radians(-roll_deg)
    cos_r, sin_r = math.cos(roll_rad), math.sin(roll_rad)

    for deg in [-30, -20, -10, 10, 20, 30]:
        py = -deg * 3.5 + pitch_px

        if abs(deg) == 10:
            half_len, thick, color = 120, 1, C_HUD_DIM
        elif abs(deg) == 20:
            half_len, thick, color = 100, 1, C_HUD_DIM
        else:
            half_len, thick, color = 80, 1, C_HUD_DIM

        # Line endpoints rotated
        lx1 = int(cx - half_len * cos_r - py * sin_r)
        ly1 = int(cy - half_len * sin_r + py * cos_r)
        lx2 = int(cx + half_len * cos_r - py * sin_r)
        ly2 = int(cy + half_len * sin_r + py * cos_r)

        ok, p1, p2 = cv2.clipLine((clip_x1, clip_y1, clip_w, clip_h), (lx1, ly1), (lx2, ly2))
        if not ok:
            continue

        # Two segments with center gap + bracket ends
        gap = 40
        mid_x = (p1[0] + p2[0]) // 2
        mid_y = (p1[1] + p2[1]) // 2
        gx = int(gap * cos_r / 2)
        gy = int(gap * sin_r / 2)
        cv2.line(frame, p1, (mid_x - gx, mid_y - gy), color, thick, cv2.LINE_AA)
        cv2.line(frame, (mid_x + gx, mid_y + gy), p2, color, thick, cv2.LINE_AA)

        # Bracket ticks at line ends (perpendicular)
        tick = 8 if deg > 0 else -8
        for ex, ey in [(lx1, ly1), (lx2, ly2)]:
            tx = int(ex + tick * sin_r)
            ty = int(ey - tick * cos_r)
            if clip_x1 < ex < clip_x1 + clip_w and clip_y1 < ey < clip_y1 + clip_h:
                cv2.line(frame, (ex, ey), (tx, ty), color, thick, cv2.LINE_AA)

        # Degree labels
        lbl = f"{abs(deg)}"
        for side, anchor in [(-1, lx1), (1, lx2)]:
            lbl_x = int(cx + (half_len + 18) * side * cos_r - py * sin_r)
            lbl_y = int(cy + (half_len + 18) * side * sin_r + py * cos_r)
            if 0 < lbl_x < w - 25 and 0 < lbl_y < h:
                cv2.putText(frame, lbl, (lbl_x - 8, lbl_y + 4), FONT, 0.32, C_HUD_DIM, 1, cv2.LINE_AA)

    # Fixed crosshair reticle (thin +)
    arm = 20
    cv2.line(frame, (cx - arm, cy), (cx + arm, cy), C_HUD_GREEN, 1, cv2.LINE_AA)
    cv2.line(frame, (cx, cy - arm), (cx, cy + arm), C_HUD_GREEN, 1, cv2.LINE_AA)

def draw_vertical_scale(frame, x, cy, scale_h, value, label, unit, right_side=False):
    """DJI-style vertical scale with moving pointer and readout box."""
    y_top = cy - scale_h // 2
    y_bot = cy + scale_h // 2
    ptr_dir = -1 if right_side else 1  # pointer points inward

    # Vertical line (scale rail)
    cv2.line(frame, (x, y_top), (x, y_bot), C_DGRAY, 1, cv2.LINE_AA)

    # Tick marks and labels
    for i in range(-5, 6):
        ty = cy - i * (scale_h // 10)
        if ty < y_top or ty > y_bot:
            continue
        tick_len = 8 if i % 2 == 0 else 4
        cv2.line(frame, (x, ty), (x + tick_len * ptr_dir, ty), C_DGRAY, 1, cv2.LINE_AA)

    # Current value pointer (filled triangle)
    py = cy - int(value * scale_h / 200.0)  # value range -100..+100
    py = max(y_top + 3, min(y_bot - 3, py))
    if right_side:
        pts = np.array([[x - 2, py], [x - 12, py - 6], [x - 12, py + 6]], np.int32)
    else:
        pts = np.array([[x + 2, py], [x + 12, py - 6], [x + 12, py + 6]], np.int32)
    cv2.fillPoly(frame, [pts], C_HUD_GREEN, cv2.LINE_AA)

    # Value readout box
    val_txt = f"{value:+.0f}" if abs(value) > 0.5 else "0"
    txt_sz = cv2.getTextSize(val_txt, FONT, 0.50, 1)[0]
    if right_side:
        bx = x + 6
    else:
        bx = x - txt_sz[0] - 16
    by = cy - txt_sz[1] // 2 - 4
    bw = txt_sz[0] + 10
    bh = txt_sz[1] + 10
    _semi_rect(frame, bx, by, bx + bw, by + bh, (0, 0, 0), 0.6)
    cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), C_HUD_GREEN, 1)
    cv2.putText(frame, val_txt, (bx + 5, by + bh - 5), FONT, 0.50, C_HUD_GREEN, 1, cv2.LINE_AA)

    # Label
    lbl_x = x - 8 if not right_side else x + 4
    cv2.putText(frame, label, (lbl_x, y_top - 8), FONT, 0.32, C_GRAY, 1, cv2.LINE_AA)
    cv2.putText(frame, unit, (lbl_x, y_bot + 16), FONT, 0.28, C_DGRAY, 1, cv2.LINE_AA)

def draw_compass(frame, cx, cy, radius, heading):
    """DJI-style circular compass rose."""
    # Outer circle
    cv2.circle(frame, (cx, cy), radius, C_DGRAY, 1, cv2.LINE_AA)

    cardinals = {0: "N", 90: "E", 180: "S", 270: "W"}
    intercardinals = {45: "NE", 135: "SE", 225: "SW", 315: "NW"}

    # Tick marks and labels (rotate by heading so current heading points up)
    for deg in range(0, 360, 10):
        angle = math.radians(deg - heading - 90)  # -90 so 0=top
        inner_r = radius - 8 if deg % 30 == 0 else radius - 4
        ox = int(cx + radius * math.cos(angle))
        oy = int(cy + radius * math.sin(angle))
        ix = int(cx + inner_r * math.cos(angle))
        iy = int(cy + inner_r * math.sin(angle))
        tick_color = C_HUD_DIM if deg % 30 != 0 else C_GRAY
        cv2.line(frame, (ix, iy), (ox, oy), tick_color, 1, cv2.LINE_AA)

        # Cardinal/intercardinal labels
        if deg in cardinals:
            lbl = cardinals[deg]
            lr = radius - 18
            lx = int(cx + lr * math.cos(angle))
            ly = int(cy + lr * math.sin(angle))
            sz = cv2.getTextSize(lbl, FONT, 0.38, 1)[0]
            color = C_RED if lbl == "N" else C_WHITE
            cv2.putText(frame, lbl, (lx - sz[0] // 2, ly + sz[1] // 2), FONT, 0.38, color, 1, cv2.LINE_AA)
        elif deg in intercardinals:
            lbl = intercardinals[deg]
            lr = radius - 18
            lx = int(cx + lr * math.cos(angle))
            ly = int(cy + lr * math.sin(angle))
            sz = cv2.getTextSize(lbl, FONT, 0.28, 1)[0]
            cv2.putText(frame, lbl, (lx - sz[0] // 2, ly + sz[1] // 2), FONT, 0.28, C_DGRAY, 1, cv2.LINE_AA)

    # Heading pointer at top (fixed triangle)
    pts = np.array([[cx, cy - radius + 2], [cx - 5, cy - radius - 6], [cx + 5, cy - radius - 6]], np.int32)
    cv2.fillPoly(frame, [pts], C_RED, cv2.LINE_AA)

    # Heading readout in center
    hdg_txt = f"{int(heading):03d}"
    sz = cv2.getTextSize(hdg_txt, FONT, 0.45, 1)[0]
    cv2.putText(frame, hdg_txt, (cx - sz[0] // 2, cy + 5), FONT, 0.45, C_WHITE, 1, cv2.LINE_AA)

def draw_stick_overlay(frame, cx, cy, radius, dx, dy, label):
    """Joystick overlay with crosshairs."""
    overlay = frame.copy()
    cv2.circle(overlay, (cx, cy), radius, (20, 20, 20), -1, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.25, frame, 0.75, 0, frame)

    cv2.line(frame, (cx - radius, cy), (cx + radius, cy), C_DGRAY, 1, cv2.LINE_AA)
    cv2.line(frame, (cx, cy - radius), (cx, cy + radius), C_DGRAY, 1, cv2.LINE_AA)
    cv2.circle(frame, (cx, cy), radius, (80, 80, 80), 1, cv2.LINE_AA)

    nx = cx + int(dx * radius * 0.85)
    ny = cy + int(dy * radius * 0.85)
    cv2.circle(frame, (nx, ny), 8, C_BGREEN, -1, cv2.LINE_AA)
    cv2.circle(frame, (nx, ny), 8, C_GREEN, 1, cv2.LINE_AA)

    sz = cv2.getTextSize(label, FONT, 0.35, 1)[0]
    cv2.putText(frame, label, (cx - sz[0] // 2, cy + radius + 14), FONT, 0.35, C_DGRAY, 1, cv2.LINE_AA)

# ── Main HUD draw ────────────────────────────────────────
def draw_hud(frame, fps):
    h, w = frame.shape[:2]

    with state.lock:
        r, p = state.roll, state.pitch
        t, y = state.throttle, state.yaw
        heading = state.heading
        flight_secs = state.flight_elapsed
        sig_lost = state.signal_lost

    # Status bar
    draw_status_bar(frame, w, fps, flight_secs)

    # Signal lost warning
    if sig_lost:
        if int(time.time() * 3) % 2:
            txt = "SIGNAL LOST"
            sz = cv2.getTextSize(txt, FONT, 1.2, 3)[0]
            cv2.putText(frame, txt, (w // 2 - sz[0] // 2, h // 2 + 80),
                        FONT, 1.2, C_RED, 3, cv2.LINE_AA)

    # Pitch ladder (center, DJI-style wide lines)
    ah_cx, ah_cy = w // 2, h // 2 - 20
    draw_pitch_ladder(frame, ah_cx, ah_cy, r, p)

    # Vertical scales — THR on left, VS on right
    thr_pct = (t - 0x80) / 1.28  # -100..+100
    vs_pct = (t - 0x80) / 1.28
    scale_x_left = w // 2 - 230
    scale_x_right = w // 2 + 230
    draw_vertical_scale(frame, scale_x_left, ah_cy, 200, thr_pct, "THR", "(%)", right_side=False)
    draw_vertical_scale(frame, scale_x_right, ah_cy, 200, vs_pct, "VS", "", right_side=True)

    # Circular compass (bottom center)
    compass_cy = h - 75
    draw_compass(frame, w // 2, compass_cy, 55, heading)

    # Stick overlays (smaller, bottom corners)
    r_dx = (r - 0x80) / 128.0
    p_dy = -(p - 0x80) / 128.0
    t_dy = -(t - 0x80) / 128.0
    y_dx = (y - 0x80) / 128.0

    draw_stick_overlay(frame, 70, h - 75, 50, y_dx, t_dy, "L")
    draw_stick_overlay(frame, w - 70, h - 75, 50, r_dx, p_dy, "R")

    # Stabilization overlay (flow vectors, correction indicators)
    draw_stab_overlay(frame, w, h)

    # Bottom info line
    _semi_rect(frame, 0, h - 18, w, h, (0, 0, 0), 0.4)
    legend = "WASD=pitch/roll  Arrows=thr/yaw  SPACE=hover  C=arm  T=takeoff  L=land  B=stab  1/2/3=speed  V=cam  R=reconnect  X=rec  Q=quit"
    cv2.putText(frame, legend, (8, h - 4), FONT, 0.26, C_DGRAY, 1, cv2.LINE_AA)

    return frame

# ── Key handler ───────────────────────────────────────────
STEP_INITIAL = 64   # first press = half deflection (0x40 from center)
STEP_RAMP    = 30   # each repeat while held adds this much toward max

def is_up(key):
    return key in (KEY_UP, KEY_UP_LINUX, 82, ord('i'))

def is_down(key):
    return key in (KEY_DOWN, KEY_DOWN_LINUX, 84, ord('k'))

def is_left(key):
    return key in (KEY_LEFT, KEY_LEFT_LINUX, 81, ord('j'))

def is_right(key):
    return key in (KEY_RIGHT, KEY_RIGHT_LINUX, 83, ord('o'))

def _key_name(key):
    names = {
        KEY_UP: "Arrow-Up(mac)", KEY_DOWN: "Arrow-Down(mac)",
        KEY_LEFT: "Arrow-Left(mac)", KEY_RIGHT: "Arrow-Right(mac)",
        KEY_UP_LINUX: "Arrow-Up(linux)", KEY_DOWN_LINUX: "Arrow-Down(linux)",
        KEY_LEFT_LINUX: "Arrow-Left(linux)", KEY_RIGHT_LINUX: "Arrow-Right(linux)",
        27: "ESC", 32: "SPACE", 13: "ENTER",
    }
    if key in names:
        return names[key]
    if 32 <= key < 127:
        return f"'{chr(key)}'"
    return "unknown"

def process_key(key):
    if key == -1:
        return

    state.key_count += 1
    log.info("KEY #%04d  code=%d (0x%x)  name=%s", state.key_count, key, key, _key_name(key))

    now = time.monotonic()

    def _stick_push(current, direction, touch_time):
        """Push stick: initial burst to half-deflection, then ramp toward max."""
        hold_thresh = STICK_HOLD_MS / 1000.0
        is_continuing = (now - touch_time) < hold_thresh
        if is_continuing:
            # Key repeat while held — ramp toward max
            step = STEP_RAMP
        else:
            # Fresh press — jump to at least half deflection
            deflection = abs(current - 0x80)
            step = max(STEP_INITIAL - deflection, STEP_RAMP) if direction > 0 else max(STEP_INITIAL - deflection, STEP_RAMP)
        if direction > 0:
            return min(255, current + step)
        else:
            return max(0, current - step)

    with state.lock:
        prev_r, prev_p, prev_t, prev_y = state.roll, state.pitch, state.throttle, state.yaw

        if   key == ord('w'):
            state.pitch = _stick_push(state.pitch, +1, state.pitch_touch)
            state.pitch_touch = now
        elif key == ord('s'):
            state.pitch = _stick_push(state.pitch, -1, state.pitch_touch)
            state.pitch_touch = now
        elif key == ord('d'):
            state.roll = _stick_push(state.roll, +1, state.roll_touch)
            state.roll_touch = now
        elif key == ord('a'):
            state.roll = _stick_push(state.roll, -1, state.roll_touch)
            state.roll_touch = now

        elif is_up(key):
            state.throttle = _stick_push(state.throttle, +1, state.thr_touch)
            state.thr_touch = now
        elif is_down(key):
            state.throttle = _stick_push(state.throttle, -1, state.thr_touch)
            state.thr_touch = now

        elif is_right(key):
            state.yaw = _stick_push(state.yaw, +1, state.yaw_touch)
            state.yaw_touch = now
        elif is_left(key):
            state.yaw = _stick_push(state.yaw, -1, state.yaw_touch)
            state.yaw_touch = now

        elif key == ord('c'):
            if not state.armed:
                state.armed = True
                state.status_msg = "ARMED - ctrl loop active"
                log.info("ACTION: ARM")
            else:
                state.armed = False
                state.flying = False
                state.cmd = 0x00
                state.throttle = 0x80
                state.roll = 0x80
                state.pitch = 0x80
                state.yaw = 0x80
                state.heading = 0.0
                state.status_msg = "DISARMED"
                log.info("ACTION: DISARM")

        elif key == ord('t'):
            was_armed = state.armed
            if not state.armed:
                state.armed = True
            set_timed_cmd(0x01, CMD_DURATION)
            state.flying = True
            state.flight_start = now
            state.flight_elapsed = 0.0
            state.status_msg = "TAKEOFF"
            log.info("ACTION: TAKEOFF (was_armed=%s)", was_armed)

        elif key == ord('l'):
            state.roll = 0x80
            state.pitch = 0x80
            state.throttle = 0x80
            state.yaw = 0x80
            set_timed_cmd(0x01, CMD_DURATION)
            state.flying = False
            state.status_msg = "LANDING"
            log.info("ACTION: LAND (cmd=0x01 toggle)")

        elif key == ord('e'):
            state.roll = 0x80
            state.pitch = 0x80
            state.throttle = 0x80
            state.yaw = 0x80
            set_timed_cmd(0x02, CMD_DURATION)
            state.flying = False
            state.status_msg = "!! EMERGENCY STOP !!"
            log.info("ACTION: EMERGENCY STOP")

        elif key in (ord('1'), ord('2'), ord('3')):
            target = key - ord('1')  # 0, 1, 2
            spd_names = ["30%", "60%", "100%"]
            spd_scales = [0.30, 0.60, 1.00]
            state.speed_mode = target
            state.speed_scale = spd_scales[target]
            state.status_msg = f"Speed: {spd_names[target]}"
            log.info("ACTION: SPEED -> %s (scale=%.2f)", spd_names[target], spd_scales[target])

        elif key == ord(' '):
            state.roll     = 0x80
            state.pitch    = 0x80
            state.yaw      = 0x80
            state.heading  = 0.0
            state.status_msg = "Hover"
            log.info("ACTION: HOVER (center roll/pitch/yaw, heading reset)")

        elif key == ord('f'):
            if state.flying:
                set_timed_cmd(0x08, 0.5)
                state.status_msg = "Flip!"
                log.info("ACTION: FLIP")

        elif key == ord('h'):
            set_timed_cmd(0x10, 0.5)
            state.status_msg = "Headless toggle"
            log.info("ACTION: HEADLESS TOGGLE")

        elif key == ord('b'):
            state.stab_enabled = not state.stab_enabled
            if state.stab_enabled:
                stabilizer.reset()
                state.status_msg = "Stabilization ON"
                log.info("ACTION: STABILIZATION ENABLED")
            else:
                state.stab_corr_roll = 0.0
                state.stab_corr_pitch = 0.0
                state.stab_corr_yaw = 0.0
                state.stab_active = False
                state.status_msg = "Stabilization OFF"
                log.info("ACTION: STABILIZATION DISABLED")

        elif key == ord('g'):
            if not state.flying:
                set_timed_cmd(0x80, 1.0)
                state.status_msg = "Gyro calibrating..."
                log.info("ACTION: GYRO CALIBRATE")

        # Log stick changes and set stabilization holdoff
        new_r, new_p, new_t, new_y = state.roll, state.pitch, state.throttle, state.yaw
        if (new_r, new_p, new_t, new_y) != (prev_r, prev_p, prev_t, prev_y):
            log.info("STICKS changed: R=%d->%d  P=%d->%d  T=%d->%d  Y=%d->%d",
                     prev_r, new_r, prev_p, new_p, prev_t, new_t, prev_y, new_y)
            # Pause stabilization while user is manually flying
            if state.stab_enabled:
                state.stab_manual_until = now + STAB_MANUAL_HOLDOFF

    # Camera switch (outside lock — switch_camera acquires its own lock)
    if key == ord('v'):
        cam = 2 if state.camera == 1 else 1
        switch_camera(cam)

# ── Recording ─────────────────────────────────────────────
def start_recording(frame):
    h, w = frame.shape[:2]
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(OUTPUT_DIR, f"rec_{ts}.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(path, fourcc, 20.0, (w, h))
    with state.lock:
        state.recorder  = writer
        state.recording = True
        state.status_msg = f"Recording: {os.path.basename(path)}"
    log.info("RECORDING started: %s", path)
    return path

def stop_recording():
    with state.lock:
        if state.recorder:
            state.recorder.release()
            state.recorder  = None
        state.recording = False
        state.status_msg = "Recording saved"
    log.info("RECORDING stopped")

def take_screenshot(frame):
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(OUTPUT_DIR, f"snap_{ts}.jpg")
    cv2.imwrite(path, frame)
    with state.lock:
        state.status_msg = f"Snap: {os.path.basename(path)}"
    log.info("SCREENSHOT: %s", path)
    return path

# ── Stream management ─────────────────────────────────────
def open_stream():
    """Open RTSP stream (non-blocking attempt). Returns cap or None."""
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;udp|max_delay;500000|reorder_queue_size;0"
    cap = cv2.VideoCapture(STREAM_URL, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    if cap.isOpened():
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        if w <= 0 or h <= 0:
            # Bogus connection — drone RTSP not ready yet (reports 0x0 @ 90000fps)
            log.warning("Stream opened but invalid resolution %dx%d @ %.0f fps — treating as failed", w, h, fps)
            cap.release()
            return None
        log.info("Stream opened: %dx%d @ %.1f fps", w, h, fps)
        return cap
    else:
        cap.release()
        log.warning("Stream open failed")
        return None

# ── Main ──────────────────────────────────────────────────
def main():
    print(f"\n  FLOW-UFO Drone Controller (KY UFO protocol)")
    print(f"  Debug log: {LOG_FILE}")
    print(f"  Output: {OUTPUT_DIR}/")

    print("  Controls:")
    print("    WASD             roll / pitch")
    print("    Up/Down (I/K)    throttle (spring-back)")
    print("    Left/Right (J/O) yaw")
    print("    SPACE            hover (center sticks, reset heading)")
    print("    C                arm / disarm")
    print("    T                takeoff (auto-arms)")
    print("    L                land (smooth)")
    print("    E                emergency stop (motors off)")
    print("    F                flip (while flying)")
    print("    G                calibrate gyro (on ground)")
    print("    H                headless mode toggle")
    print("    B                toggle vision stabilization")
    print("    1 / 2 / 3        speed mode (30% / 60% / 100%)")
    print("    V                switch camera")
    print("    R                reconnect stream")
    print("    X                start / stop recording")
    print("    P                screenshot")
    print("    Q / ESC          quit\n")

    # Start background threads
    threading.Thread(target=heartbeat_loop, daemon=True, name="heartbeat").start()
    threading.Thread(target=ctrl_loop, daemon=True, name="ctrl").start()
    threading.Thread(target=telemetry_loop, daemon=True, name="telemetry").start()

    # Try initial stream connection
    print(f"  Connecting to {STREAM_URL} ...")
    log.info("Opening RTSP stream: %s (UDP transport)", STREAM_URL)
    cap = open_stream()
    if cap:
        print(f"  [OK] Stream connected\n")
        state.signal_lost = False
        state.last_good_frame = time.monotonic()
    else:
        print(f"  [--] No stream — press R to reconnect\n")
        state.signal_lost = True
        state.status_msg = "No stream — press R to reconnect"
        cap = None

    cv2.namedWindow("FLOW-UFO", cv2.WINDOW_NORMAL)
    cv2.resizeWindow("FLOW-UFO", DISPLAY_W, DISPLAY_H)

    fps_time  = time.time()
    fps_count = 0
    fps       = 0.0
    clean_frame = None
    frame_total = 0
    frame_drops = 0
    reconnecting = False

    while state.running:
        # Release old capture as soon as camera switch is pending
        if state.reconnect_at > 0 and cap is not None:
            cap.release()
            cap = None

        got_frame = False
        if cap is not None:
            ret, frame = cap.read()
            if not ret:
                frame_drops += 1
                state.consec_drops += 1
                # Throttle loop when dropping frames — prevents spinning at 1000Hz
                # which would trigger signal_lost from a tiny WiFi hiccup
                time.sleep(0.03)  # ~33ms = roughly one frame period at 30fps
                # Time-based signal loss: only declare lost after 2s of no frames
                # (old: 30 count-based drops which happened in <50ms)
                mono_now = time.monotonic()
                if state.last_good_frame > 0 and (mono_now - state.last_good_frame) > 2.0:
                    if not state.signal_lost:
                        state.signal_lost = True
                        state.status_msg = "Signal lost — auto-reconnecting..."
                        # Kill stale stabilization corrections immediately
                        state.stab_active = False
                        state.stab_corr_roll = 0.0
                        state.stab_corr_pitch = 0.0
                        state.stab_corr_yaw = 0.0
                        stabilizer.reset()
                        log.warning("Signal lost (no frame for %.1fs, %d drops) — stabilization zeroed",
                                    mono_now - state.last_good_frame, state.consec_drops)
                        # Schedule auto-reconnect (release current dead capture, reconnect in 0.5s)
                        if state.reconnect_at <= 0:
                            cap.release()
                            cap = None
                            state.reconnect_at = mono_now + 0.5
                            state.reconnect_retries = 5
                            log.info("Auto-reconnect scheduled after signal loss")
            else:
                got_frame = True
                state.consec_drops = 0
                state.last_good_frame = time.monotonic()
                if state.signal_lost:
                    state.signal_lost = False
                    state.status_msg = "Signal restored"
                    log.info("Signal restored after %d total drops", frame_drops)
                frame_total += 1

                # Run optical flow on original stream frame (smaller = faster)
                # Only every 3rd frame to keep main loop responsive
                if state.stab_enabled and state.armed and frame_total % 3 == 0:
                    compute_stabilization(frame)

                frame = cv2.resize(frame, (DISPLAY_W, DISPLAY_H))
                clean_frame = frame.copy()

                fps_count += 1
                now = time.time()
                if now - fps_time >= 1.0:
                    fps = fps_count / (now - fps_time)
                    fps_count = 0
                    fps_time  = now

        if not got_frame:
            frame = np.zeros((DISPLAY_H, DISPLAY_W, 3), dtype=np.uint8)

        # Auto-reconnect (after camera switch OR signal loss) with retries
        if state.reconnect_at > 0 and time.monotonic() >= state.reconnect_at:
            state.reconnect_at = 0.0
            retries_left = state.reconnect_retries
            log.info("Auto-reconnect attempt (retries left: %d)", retries_left)
            cap = open_stream()
            if cap:
                state.signal_lost = False
                state.consec_drops = 0
                state.last_good_frame = time.monotonic()
                state.reconnect_retries = 0
                state.status_msg = "Reconnected"
            elif retries_left > 0:
                state.reconnect_retries = retries_left - 1
                state.reconnect_at = time.monotonic() + 1.5  # retry in 1.5s (give drone time)
                state.status_msg = f"Reconnecting... ({retries_left} left)"
                log.info("Auto-reconnect failed, retrying in 1.5s")
            else:
                state.signal_lost = True
                state.status_msg = "Reconnect failed — press R to retry"

        frame = draw_hud(frame, fps)

        # Record/screenshot with HUD overlay baked in
        with state.lock:
            if state.recording and state.recorder:
                state.recorder.write(frame)

        cv2.imshow("FLOW-UFO", frame)

        key = cv2.waitKeyEx(1)

        if key == ord('q') or key == 27:
            log.info("QUIT requested (flying=%s)", state.flying)
            break

        if key == ord('r'):
            # Reconnect stream (cancel any pending auto-reconnect)
            state.reconnect_at = 0.0
            state.reconnect_retries = 0
            if cap is not None:
                cap.release()
            state.status_msg = "Reconnecting..."
            log.info("Manual reconnect requested")
            cap = open_stream()
            if cap:
                state.signal_lost = False
                state.consec_drops = 0
                state.last_good_frame = time.monotonic()
                state.status_msg = "Reconnected"
            else:
                state.signal_lost = True
                state.status_msg = "Reconnect failed — press R to retry"

        if key == ord('x'):
            # Toggle recording
            if state.recording:
                stop_recording()
            elif clean_frame is not None:
                start_recording(clean_frame)

        if key == ord('p'):
            take_screenshot(frame)

        process_key(key)

    # Cleanup
    state.running = False
    if state.recording:
        stop_recording()
    if cap is not None:
        cap.release()
    cv2.destroyAllWindows()

    log.info("=== Session summary ===")
    log.info("Frames received: %d, dropped: %d", frame_total, frame_drops)
    log.info("TX packets: %d, RX packets: %d, Heartbeats: %d", state.tx_count, state.rx_count, state.hb_count)
    log.info("Keypresses: %d", state.key_count)
    log.info("=== Shutdown complete ===")

    print(f"\n  Files saved to: {OUTPUT_DIR}/")
    print(f"  Debug log: {LOG_FILE}\n")

if __name__ == "__main__":
    main()
