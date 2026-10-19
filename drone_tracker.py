#!/usr/bin/env python3
"""
FLOW-UFO Autonomous Target Tracker
===================================
Smith Predictor + Pitch-Coupling Compensation + Pursuit State Machine

Tracks a person via YOLO on a delayed Wi-Fi video stream, compensates for
200-500ms round-trip latency and fixed-camera kinematic coupling, then
outputs 4-axis flight commands to keep the target centered.

Architecture:
  1. YOLO person detection on GPU (RTX 3070)
  2. Pitch/roll coupling compensation (remove drone-attitude artifacts)
  3. Smith Predictor (delay-free state estimate via internal forward model)
  4. Predictive lead (target velocity × latency)
  5. PD controller with gain scheduling per tracking phase
  6. 5-state machine: SEARCH → ACQUIRE → TRACK → COAST → INTERCEPT

Usage:
  python drone_tracker.py [--model yolov8n.pt] [--source rtsp://...] [--debug]

Controls while running:
  SPACE     Toggle autonomous tracking ON / OFF
  T         Takeoff (auto-arms)
  L         Land
  E         Emergency stop (motors off)
  1 / 2 / 3 Speed mode 30% / 60% / 100%
  Q / ESC   Quit (auto-lands if flying)

Dependencies:
  pip install ultralytics opencv-python numpy
"""

import cv2
import numpy as np
import socket
import threading
import time
import math
import sys
import os
import logging
import argparse
from collections import deque

# ═══════════════════════════════════════════════════════════════════════
#  IMPORT DRONE PROTOCOL FROM EXISTING CONTROLLER
# ═══════════════════════════════════════════════════════════════════════
import importlib.util

_ctrl_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "drone_controller.py")
if not os.path.isfile(_ctrl_path):
    print(f"ERROR: Cannot find drone_controller.py at {_ctrl_path}")
    sys.exit(1)

_spec = importlib.util.spec_from_file_location("drone_controller", _ctrl_path)
dc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dc)

# Re-export the functions and objects we need
build_ctrl     = dc.build_ctrl       # (roll,pitch,thr,yaw,cmd,spd) → bytes
_safe_send     = dc._safe_send       # bytes → bool  (uses dc.sock)
send_heartbeat = dc.send_heartbeat   # () → None
open_stream    = dc.open_stream      # () → cv2.VideoCapture | None
DRONE_IP       = dc.DRONE_IP
CTRL_PORT      = dc.CTRL_PORT
STREAM_URL     = dc.STREAM_URL

# ═══════════════════════════════════════════════════════════════════════
#  YOLO IMPORT
# ═══════════════════════════════════════════════════════════════════════
try:
    from ultralytics import YOLO
except ImportError:
    print("ERROR: ultralytics not installed.  Run:  pip install ultralytics")
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════
#  CONFIGURATION — ALL TUNABLES IN ONE PLACE
# ═══════════════════════════════════════════════════════════════════════

# ── Timing ──────────────────────────────────────────────────────────
CTRL_HZ           = 20       # Flight-command packet rate (Hz)
HEARTBEAT_HZ      = 1        # Heartbeat rate (Hz)
YOLO_EVERY_N      = 1        # Run YOLO every frame (RTX 3070 handles yolo26n easily)
DISPLAY_W         = 960
DISPLAY_H         = 540

# ── YOLO ────────────────────────────────────────────────────────────
YOLO_MODEL_PATH   = "yolo26n.pt"   # YOLO26 Nano (Jan 2026), NMS-free, ~43% faster than YOLO11
YOLO_CONF         = 0.30           # min confidence (lowered for testing phase)
YOLO_IOU          = 0.50           # NMS IoU threshold
YOLO_TARGET_CLS   = 0              # COCO class 0 = person

# ── Smith Predictor ─────────────────────────────────────────────────
TAU_DEFAULT       = 0.080     # Estimated one-way video latency (seconds) — near-live stream
K_CMD_TO_PX       = 120.0    # Pixels/sec displacement per unit stick-deflection
                              # CALIBRATE: pitch drone, measure pixel flow rate
K_DRAG            = 3.5      # Velocity damping coefficient
                              # CALIBRATE: release stick, measure time to stop

# ── Pitch / Roll Coupling ──────────────────────────────────────────
K_PITCH_COUPLING  = 15.0     # Pixels of vertical shift per degree of pitch
                              # CALIBRATE: pitch 10°, measure target Y-shift
K_ROLL_COUPLING   = 8.0      # Pixels of horizontal shift per degree of roll
K_MAX_ANGLE_DEG   = 20.0     # Max tilt at full stick deflection
TAU_ATTITUDE      = 0.15     # First-order lag time constant (seconds)

# ── PD Controller Gains (per state) ────────────────────────────────
#    Format: (Kp, Kd)
GAINS_ACQUIRE     = (0.12, 0.90)   # gentle approach, heavy damping
GAINS_TRACK       = (0.35, 0.70)   # balanced pursuit
GAINS_INTERCEPT   = (0.50, 0.45)   # aggressive, less damping
GAINS_COAST       = (0.00, 0.00)   # open-loop dead-reckoning (no PD)

# ── Authority Limits ───────────────────────────────────────────────
MAX_ROLL          = 45       # Max deflection from center (0-127)
MAX_PITCH         = 45
MAX_YAW           = 35
MAX_THROTTLE_D    = 20       # Max throttle deviation from hover (128)
DEADZONE_PX       = 8        # Below this pixel-error → zero correction

# ── State-Machine Thresholds ──────────────────────────────────────
ACQUIRE_N         = 4        # Consecutive detections to transition ACQUIRE→TRACK
COAST_TIMEOUT_S   = 2.0      # No detection for this long → fall back to SEARCH
INTERCEPT_AREA    = 0.06     # BBox area / frame area → enter INTERCEPT
SEARCH_YAW_RATE   = 20       # Yaw stick deflection while searching

# ── Target Velocity ───────────────────────────────────────────────
VEL_ALPHA         = 0.25     # EMA smoothing for target velocity
LEAD_GAIN         = 1.0      # Multiplier on v*τ predictive lead

# ── Manual Override ───────────────────────────────────────────────
MANUAL_HOLDOFF_S  = 0.6      # Pause autonomy after any manual stick input

# ═══════════════════════════════════════════════════════════════════════
#  LOGGING
# ═══════════════════════════════════════════════════════════════════════
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "tracker_debug.log")
log = logging.getLogger("tracker")
log.setLevel(logging.DEBUG)
_fh = logging.FileHandler(LOG_PATH, mode="w")
_fh.setLevel(logging.DEBUG)
_fh.setFormatter(logging.Formatter(
    "%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s", datefmt="%H:%M:%S"))
log.addHandler(_fh)
_ch = logging.StreamHandler()
_ch.setLevel(logging.DEBUG if "--debug" in sys.argv else logging.WARNING)
_ch.setFormatter(logging.Formatter("  TRACKER │ %(message)s"))
log.addHandler(_ch)
log.info("=== Autonomous Tracker started ===")

# ═══════════════════════════════════════════════════════════════════════
#  SMITH PREDICTOR
# ═══════════════════════════════════════════════════════════════════════

class SmithPredictor:
    """
    Compensates for known transport delay τ between command dispatch and
    visual observation.

    Maintains a ring-buffer of timestamped commands and integrates a
    simplified kinematic forward model to predict the drone's pixel-space
    displacement at any past or present time.

    The *model error* (observation − prediction-at-observation-time) is
    added to the current-time prediction to produce a delay-free estimate.
    """

    def __init__(self, tau=TAU_DEFAULT, k_cmd=K_CMD_TO_PX, k_drag=K_DRAG):
        self.tau        = tau
        self.k_cmd      = k_cmd
        self.k_drag     = k_drag
        self.cmd_buf    = deque(maxlen=500)   # ~25 s at 20 Hz
        self.model_err_x = 0.0
        self.model_err_y = 0.0
        self._lock      = threading.Lock()

    # ── record every outgoing command ──────────────────────────────
    def record(self, roll, pitch, timestamp):
        """Called by the control thread each tick."""
        with self._lock:
            self.cmd_buf.append((timestamp, roll, pitch))

    # ── integrate forward model up to *up_to* ─────────────────────
    def _integrate(self, up_to):
        """Return predicted (dx, dy) pixel displacement at *up_to*."""
        vx, vy = 0.0, 0.0
        px, py = 0.0, 0.0
        buf = list(self.cmd_buf)
        for i, (t, r, p) in enumerate(buf):
            if t > up_to:
                break
            t_next = buf[i + 1][0] if i + 1 < len(buf) else up_to
            dt = min(t_next, up_to) - t
            if dt <= 0:
                continue
            norm_r = (r - 128) / 128.0
            norm_p = (p - 128) / 128.0
            vx += self.k_cmd * norm_r * dt
            vy += self.k_cmd * norm_p * dt
            px += vx * dt
            py += vy * dt
            vx *= max(0.0, 1.0 - self.k_drag * dt)
            vy *= max(0.0, 1.0 - self.k_drag * dt)
        return px, py

    # ── update model error with a new observation ─────────────────
    def update(self, observed_offset_x, observed_offset_y, t_now):
        """
        Call when a new YOLO detection arrives.
        observed_offset = target_center − screen_center  (pixels).
        """
        with self._lock:
            t_obs = t_now - self.tau
            pred_obs_x, pred_obs_y = self._integrate(t_obs)
            # Drone moved right → target appears left → predicted target offset
            self.model_err_x = observed_offset_x - (-pred_obs_x)
            self.model_err_y = observed_offset_y - (-pred_obs_y)

    # ── produce delay-free corrected estimate ─────────────────────
    def estimate(self, t_now):
        """Return (offset_x, offset_y) corrected for delay."""
        with self._lock:
            pred_now_x, pred_now_y = self._integrate(t_now)
            est_x = (-pred_now_x) + self.model_err_x
            est_y = (-pred_now_y) + self.model_err_y
            return est_x, est_y


# ═══════════════════════════════════════════════════════════════════════
#  ATTITUDE ESTIMATOR  (pitch / roll from command history)
# ═══════════════════════════════════════════════════════════════════════

class AttitudeEstimator:
    """
    Estimates the drone's current pitch and roll angles from the commands
    we have dispatched.  Uses a first-order lag model:
        θ(t) → θ_cmd  with time-constant τ_att
    """

    def __init__(self):
        self.theta_pitch = 0.0   # degrees, positive = nose down
        self.theta_roll  = 0.0   # degrees, positive = right wing down

    def update(self, cmd_pitch, cmd_roll, dt):
        target_p = K_MAX_ANGLE_DEG * (cmd_pitch - 128) / 128.0
        target_r = K_MAX_ANGLE_DEG * (cmd_roll  - 128) / 128.0
        alpha = 1.0 - math.exp(-dt / TAU_ATTITUDE) if dt > 0 else 0.0
        self.theta_pitch += (target_p - self.theta_pitch) * alpha
        self.theta_roll  += (target_r - self.theta_roll)  * alpha

    def pitch_artifact_y(self):
        """Vertical pixel shift caused by our own pitch."""
        # Positive pitch (forward / nose-down) → camera pitches down →
        # fixed ground point moves UP in frame (Y decreases).
        # Return the shift to SUBTRACT from observed cy.
        return -K_PITCH_COUPLING * self.theta_pitch

    def roll_artifact_x(self):
        """Horizontal pixel shift caused by our own roll."""
        return -K_ROLL_COUPLING * self.theta_roll


# ═══════════════════════════════════════════════════════════════════════
#  TARGET VELOCITY ESTIMATOR
# ═══════════════════════════════════════════════════════════════════════

class VelocityEstimator:
    """
    Estimates target velocity in pixels/second from compensated bounding-box
    center positions.  Uses an exponential moving average for smoothing.
    """

    def __init__(self):
        self.vx = 0.0
        self.vy = 0.0
        self.prev_cx = None
        self.prev_cy = None
        self.prev_t  = None

    def update(self, cx, cy, t):
        if self.prev_cx is not None and self.prev_t is not None:
            dt = t - self.prev_t
            if dt > 0.001:
                raw_vx = (cx - self.prev_cx) / dt
                raw_vy = (cy - self.prev_cy) / dt
                self.vx = VEL_ALPHA * raw_vx + (1 - VEL_ALPHA) * self.vx
                self.vy = VEL_ALPHA * raw_vy + (1 - VEL_ALPHA) * self.vy
        self.prev_cx, self.prev_cy, self.prev_t = cx, cy, t

    def lead(self, tau):
        """Return (lead_x, lead_y): predicted pixel displacement over τ."""
        return self.vx * tau * LEAD_GAIN, self.vy * tau * LEAD_GAIN

    def reset(self):
        self.vx = self.vy = 0.0
        self.prev_cx = self.prev_cy = self.prev_t = None


# ═══════════════════════════════════════════════════════════════════════
#  TRACKING CONTROLLER  (state machine + PD + orchestration)
# ═══════════════════════════════════════════════════════════════════════

# Tracking states
S_SEARCH    = "SEARCH"
S_ACQUIRE   = "ACQUIRE"
S_TRACK     = "TRACK"
S_COAST     = "COAST"
S_INTERCEPT = "INTERCEPT"

class TrackingController:
    """
    Orchestrates detection → estimation → control for autonomous tracking.
    """

    def __init__(self):
        self.smith        = SmithPredictor()
        self.attitude     = AttitudeEstimator()
        self.vel_est      = VelocityEstimator()

        # ── State machine ──
        self.state        = S_SEARCH
        self.consec_det   = 0
        self.last_det_t   = 0.0

        # ── PD memory ──
        self.prev_err_x   = 0.0
        self.prev_err_y   = 0.0

        # ── Output commands (written by tracker, read by ctrl thread) ──
        self.lock         = threading.Lock()
        self.out_roll     = 128
        self.out_pitch    = 128
        self.out_yaw      = 128
        self.out_throttle = 128
        self.out_cmd      = 0x00
        self.out_cmd_until = 0.0

        # ── Autonomy flags ──
        self.autonomous   = False    # toggled by SPACE
        self.armed        = False
        self.flying       = False
        self.speed_byte   = 0x02
        self.speed_scale  = 1.0
        self.manual_until = 0.0      # pause autonomy after manual input

        # ── Telemetry (for HUD) ──
        self.hud_state           = S_SEARCH
        self.hud_bbox            = None
        self.hud_corrected       = (0, 0)
        self.hud_lead            = (0, 0)
        self.hud_model_err       = (0, 0)
        self.hud_target_vel      = (0, 0)
        self.hud_pitch_est       = 0.0
        self.hud_roll_est        = 0.0
        self.hud_area_frac       = 0.0
        self.hud_tau             = TAU_DEFAULT
        self.tx_count            = 0
        self.hb_count            = 0

    # ────────────────────────────────────────────────────────────────
    #  MAIN ENTRY: process one detection result
    # ────────────────────────────────────────────────────────────────
    def process(self, bbox, frame_w, frame_h, timestamp):
        """
        bbox: (x, y, w, h) in pixels or None if no detection.
        Updates internal state and self.out_* command values.
        """
        screen_cx = frame_w / 2.0
        screen_cy = frame_h / 2.0
        t_now     = timestamp

        # ── Manual holdoff check ──
        if t_now < self.manual_until:
            return

        # ── No detection branch ──
        if bbox is None:
            self.consec_det = 0
            if self.state in (S_TRACK, S_INTERCEPT):
                self.state = S_COAST
                self.last_det_t = t_now
                log.info("Target lost → COAST")
            elif self.state == S_COAST:
                if t_now - self.last_det_t > COAST_TIMEOUT_S:
                    self.state = S_SEARCH
                    self.vel_est.reset()
                    log.info("Coast timeout → SEARCH")
                else:
                    self._do_coast(screen_cx, screen_cy, t_now)
            elif self.state == S_ACQUIRE:
                self.consec_det = 0
                self.state = S_SEARCH
            # SEARCH: slow yaw scan
            if self.state == S_SEARCH:
                self._do_search()
            self._publish_hud(bbox, (0, 0), (0, 0))
            return

        # ── We have a detection ──
        self.consec_det += 1
        self.last_det_t = t_now

        bx, by, bw, bh = bbox
        raw_cx = bx + bw / 2.0
        raw_cy = by + bh / 2.0
        area   = bw * bh
        area_frac = area / (frame_w * frame_h)
        self.hud_area_frac = area_frac

        # ── Step 1: Remove pitch / roll coupling artifacts ──
        comp_cx = raw_cx - self.attitude.roll_artifact_x()
        comp_cy = raw_cy - self.attitude.pitch_artifact_y()

        # ── Step 2: Update target velocity estimate ──
        self.vel_est.update(comp_cx, comp_cy, t_now)

        # ── Step 3: Smith Predictor observation update ──
        obs_off_x = comp_cx - screen_cx
        obs_off_y = comp_cy - screen_cy
        self.smith.update(obs_off_x, obs_off_y, t_now)

        # ── Step 4: Corrected delay-free estimate ──
        est_x, est_y = self.smith.estimate(t_now)

        # ── Step 5: Predictive lead ──
        lead_x, lead_y = self.vel_est.lead(self.smith.tau)
        final_off_x = est_x + lead_x
        final_off_y = est_y + lead_y

        # ── Step 6: State transitions ──
        self._transition(area_frac)

        # ── Step 7: PD controller ──
        kp, kd = self._current_gains()

        # Apply deadzone
        err_x = final_off_x if abs(final_off_x) > DEADZONE_PX else 0.0
        err_y = final_off_y if abs(final_off_y) > DEADZONE_PX else 0.0

        d_err_x = err_x - self.prev_err_x
        d_err_y = err_y - self.prev_err_y
        self.prev_err_x = err_x
        self.prev_err_y = err_y

        # Roll: positive error = target right → roll right (stick > 128)
        roll_d = kp * err_x + kd * d_err_x
        # Pitch: positive error = target below center → pitch backward (stick < 128)
        #        negative error = target above center → pitch forward (stick > 128)
        pitch_d = -(kp * err_y + kd * d_err_y)

        # Yaw: for large horizontal offsets, add yaw to turn toward target
        yaw_d = 0.0
        if abs(err_x) > frame_w * 0.20:
            yaw_d = 0.15 * err_x

        # Throttle: maintain altitude, slight modulation on area
        thr_d = 0.0

        # ── Step 8: Clamp & output ──
        self._set_commands(roll_d, pitch_d, yaw_d, thr_d)
        self._publish_hud(bbox, (est_x, est_y), (lead_x, lead_y))

    # ────────────────────────────────────────────────────────────────
    #  State transition logic
    # ────────────────────────────────────────────────────────────────
    def _transition(self, area_frac):
        prev = self.state
        if self.state == S_SEARCH:
            if self.consec_det >= 1:
                self.state = S_ACQUIRE
        elif self.state == S_ACQUIRE:
            if self.consec_det >= ACQUIRE_N:
                self.state = S_TRACK
        elif self.state == S_TRACK:
            if area_frac >= INTERCEPT_AREA:
                self.state = S_INTERCEPT
        elif self.state == S_INTERCEPT:
            if area_frac < INTERCEPT_AREA * 0.6:
                self.state = S_TRACK
        elif self.state == S_COAST:
            if self.consec_det >= 2:
                self.state = S_TRACK
        if self.state != prev:
            log.info("State: %s → %s  (area=%.3f, consec=%d)",
                     prev, self.state, area_frac, self.consec_det)
            # ── Bug-fix #3: Flush yaw-contaminated velocity when leaving SEARCH ──
            # During SEARCH the drone yaws continuously, so any detected target
            # has artificial horizontal velocity from the rotation.  Reset the
            # velocity estimator so ACQUIRE/TRACK start with clean data.
            if prev == S_SEARCH and self.state == S_ACQUIRE:
                self.vel_est.reset()
                with self.lock:
                    self.out_yaw = 128   # stop search rotation immediately
            # ── Bug-fix #4: Reset PD error memory on re-acquisition ──
            # Prevents a derivative-kick spike when error jumps between the
            # stale prev_err from before target loss and the fresh detection.
            if prev in (S_COAST, S_SEARCH, S_ACQUIRE):
                self.prev_err_x = 0.0
                self.prev_err_y = 0.0

    def _current_gains(self):
        return {
            S_ACQUIRE:   GAINS_ACQUIRE,
            S_TRACK:     GAINS_TRACK,
            S_INTERCEPT: GAINS_INTERCEPT,
            S_COAST:     GAINS_COAST,
        }.get(self.state, GAINS_TRACK)

    # ────────────────────────────────────────────────────────────────
    #  Behavioural sub-routines
    # ────────────────────────────────────────────────────────────────
    def _do_search(self):
        """Slow yaw rotation to scan for target."""
        with self.lock:
            self.out_roll     = 128
            self.out_pitch    = 128
            self.out_yaw      = 128 + SEARCH_YAW_RATE
            self.out_throttle = 128

    def _do_coast(self, scx, scy, t_now):
        """
        Dead reckoning: extrapolate last known velocity.
        Smith Predictor estimate still updates (model integrates our cmds).
        """
        est_x, est_y = self.smith.estimate(t_now)
        lead_x, lead_y = self.vel_est.lead(self.smith.tau)
        final_x = est_x + lead_x
        final_y = est_y + lead_y

        kp, kd = GAINS_TRACK   # use track gains for coast glide
        # Reduced authority during coast (less trust in stale data)
        roll_d  = 0.5 * kp * final_x
        pitch_d = -0.5 * kp * final_y
        self._set_commands(roll_d, pitch_d, 0, 0)

    # ────────────────────────────────────────────────────────────────
    #  Command output helpers
    # ────────────────────────────────────────────────────────────────
    def _clamp_axis(self, delta, limit):
        clamped = max(-limit, min(limit, delta))
        return int(128 + clamped)

    def _set_commands(self, roll_d, pitch_d, yaw_d, thr_d):
        with self.lock:
            self.out_roll     = self._clamp_axis(roll_d,  MAX_ROLL)
            self.out_pitch    = self._clamp_axis(pitch_d, MAX_PITCH)
            self.out_yaw      = self._clamp_axis(yaw_d,   MAX_YAW)
            self.out_throttle = self._clamp_axis(thr_d,   MAX_THROTTLE_D)

    def get_commands(self):
        """Read current command tuple (thread-safe)."""
        with self.lock:
            t = time.monotonic()
            cmd = self.out_cmd
            if cmd != 0x00 and t >= self.out_cmd_until:
                cmd = 0x00
                self.out_cmd = 0x00
            return (self.out_roll, self.out_pitch,
                    self.out_throttle, self.out_yaw, cmd)

    def set_timed_cmd(self, cmd, duration=1.0):
        with self.lock:
            self.out_cmd = cmd
            self.out_cmd_until = time.monotonic() + duration

    # ────────────────────────────────────────────────────────────────
    #  Attitude update (called by ctrl thread each tick)
    # ────────────────────────────────────────────────────────────────
    def tick_attitude(self, roll, pitch, dt):
        self.attitude.update(pitch, roll, dt)
        self.hud_pitch_est = self.attitude.theta_pitch
        self.hud_roll_est  = self.attitude.theta_roll

    # ────────────────────────────────────────────────────────────────
    #  HUD telemetry snapshot
    # ────────────────────────────────────────────────────────────────
    def _publish_hud(self, bbox, corrected, lead):
        self.hud_state      = self.state
        self.hud_bbox       = bbox
        self.hud_corrected  = corrected
        self.hud_lead       = lead
        self.hud_model_err  = (self.smith.model_err_x, self.smith.model_err_y)
        self.hud_target_vel = (self.vel_est.vx, self.vel_est.vy)
        self.hud_tau        = self.smith.tau


# ═══════════════════════════════════════════════════════════════════════
#  CONTROL THREAD (20 Hz)
# ═══════════════════════════════════════════════════════════════════════

def ctrl_loop(tc: TrackingController, running_flag: list):
    interval = 1.0 / CTRL_HZ
    next_tick = time.monotonic()
    log.info("Control loop started at %d Hz", CTRL_HZ)

    while running_flag[0]:
        t = time.monotonic()
        if tc.armed:
            r, p, thr, y, cmd = tc.get_commands()

            # Scale by speed setting
            sc = tc.speed_scale
            r_s = int(max(0, min(255, 128 + (r - 128) * sc)))
            p_s = int(max(0, min(255, 128 + (p - 128) * sc)))
            y_s = int(max(0, min(255, 128 + (y - 128) * sc)))
            thr_s = int(max(0, min(255, 128 + (thr - 128) * sc)))

            pkt = build_ctrl(r_s, p_s, thr_s, y_s, cmd, tc.speed_byte)
            _safe_send(pkt)
            tc.tx_count += 1

            # Record for Smith Predictor
            tc.smith.record(r, p, t)
            # Update attitude estimate
            tc.tick_attitude(r, p, interval)

        next_tick += interval
        sleep_dur = next_tick - time.monotonic()
        if sleep_dur > 0:
            time.sleep(sleep_dur)
        else:
            next_tick = time.monotonic()

    log.info("Control loop stopped.  TX=%d", tc.tx_count)


def heartbeat_loop(tc: TrackingController, running_flag: list):
    interval = 1.0 / HEARTBEAT_HZ
    log.info("Heartbeat loop started at %d Hz", HEARTBEAT_HZ)
    while running_flag[0]:
        send_heartbeat()
        tc.hb_count += 1
        time.sleep(interval)
    log.info("Heartbeat loop stopped.  HB=%d", tc.hb_count)


# ═══════════════════════════════════════════════════════════════════════
#  HUD DRAWING
# ═══════════════════════════════════════════════════════════════════════

FONT = cv2.FONT_HERSHEY_SIMPLEX

# Colour palette (BGR)
C_GREEN   = (80, 220, 80)
C_YELLOW  = (50, 220, 220)
C_RED     = (50, 50, 220)
C_CYAN    = (220, 200, 50)
C_WHITE   = (230, 230, 230)
C_GRAY    = (140, 140, 140)
C_DGRAY   = (80, 80, 80)
C_ORANGE  = (50, 140, 240)
C_MAGENTA = (200, 50, 200)

STATE_COLORS = {
    S_SEARCH:    C_GRAY,
    S_ACQUIRE:   C_YELLOW,
    S_TRACK:     C_GREEN,
    S_COAST:     C_CYAN,
    S_INTERCEPT: C_ORANGE,
}


def _semi_rect(frame, x1, y1, x2, y2, color, alpha):
    ry1, ry2 = max(0, y1), min(frame.shape[0], y2)
    rx1, rx2 = max(0, x1), min(frame.shape[1], x2)
    if ry2 <= ry1 or rx2 <= rx1:
        return
    sub = frame[ry1:ry2, rx1:rx2].copy()
    cv2.rectangle(frame, (rx1, ry1), (rx2, ry2), color, -1)
    cv2.addWeighted(frame[ry1:ry2, rx1:rx2], alpha, sub, 1 - alpha, 0,
                    frame[ry1:ry2, rx1:rx2])


def draw_tracking_hud(frame, tc: TrackingController, fps):
    h, w = frame.shape[:2]
    scx, scy = w // 2, h // 2
    st_color = STATE_COLORS.get(tc.hud_state, C_WHITE)

    # ── Top status bar ──────────────────────────────────────────
    _semi_rect(frame, 0, 0, w, 38, (0, 0, 0), 0.55)
    x = 12
    y_txt = 26

    # Autonomy indicator
    if tc.autonomous:
        cv2.putText(frame, "AUTO", (x, y_txt), FONT, 0.50, C_GREEN, 2,
                    cv2.LINE_AA)
    else:
        cv2.putText(frame, "MANUAL", (x, y_txt), FONT, 0.50, C_DGRAY, 1,
                    cv2.LINE_AA)
    x += 85

    # State badge
    cv2.putText(frame, tc.hud_state, (x, y_txt), FONT, 0.55, st_color, 2,
                cv2.LINE_AA)
    x += 130

    # Armed / flying
    arm_txt = "ARMED" if tc.armed else "DISARMED"
    arm_col = C_GREEN if tc.armed else C_DGRAY
    cv2.putText(frame, arm_txt, (x, y_txt), FONT, 0.38, arm_col, 1,
                cv2.LINE_AA)
    x += 90

    if tc.flying:
        cv2.putText(frame, "FLY", (x, y_txt), FONT, 0.38, C_CYAN, 1,
                    cv2.LINE_AA)
    x += 50

    # Right side
    rx = w - 12
    cv2.putText(frame, f"{fps:.0f} fps", (rx - 70, y_txt), FONT, 0.38,
                C_DGRAY, 1, cv2.LINE_AA)
    cv2.putText(frame, f"TX:{tc.tx_count}", (rx - 170, y_txt), FONT, 0.32,
                C_DGRAY, 1, cv2.LINE_AA)

    # ── Bounding box ────────────────────────────────────────────
    bbox = tc.hud_bbox
    if bbox is not None:
        bx, by, bw, bh = [int(v) for v in bbox]
        cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), st_color, 2,
                      cv2.LINE_AA)
        # Confidence / area label
        cv2.putText(frame, f"AREA {tc.hud_area_frac:.3f}", (bx, by - 6),
                    FONT, 0.32, st_color, 1, cv2.LINE_AA)

    # ── Center reticle (fixed reference) ────────────────────────
    arm = 18
    cv2.line(frame, (scx - arm, scy), (scx + arm, scy), C_DGRAY, 1,
             cv2.LINE_AA)
    cv2.line(frame, (scx, scy - arm), (scx, scy + arm), C_DGRAY, 1,
             cv2.LINE_AA)

    # ── Smith Predictor corrected position ──────────────────────
    ex, ey = tc.hud_corrected
    cpx = int(scx + ex)
    cpy = int(scy + ey)
    if 0 < cpx < w and 0 < cpy < h:
        # Crosshair at corrected estimate
        cv2.drawMarker(frame, (cpx, cpy), C_GREEN, cv2.MARKER_CROSS, 20, 2,
                       cv2.LINE_AA)

    # ── Predictive lead point ───────────────────────────────────
    lx, ly = tc.hud_lead
    lpx = int(scx + ex + lx)
    lpy = int(scy + ey + ly)
    if 0 < lpx < w and 0 < lpy < h:
        cv2.circle(frame, (lpx, lpy), 6, C_MAGENTA, 2, cv2.LINE_AA)
        # Line from corrected to lead
        cv2.line(frame, (cpx, cpy), (lpx, lpy), C_MAGENTA, 1, cv2.LINE_AA)

    # ── Target velocity vector ──────────────────────────────────
    vx, vy = tc.hud_target_vel
    if bbox is not None and (abs(vx) > 5 or abs(vy) > 5):
        bcx = int(bbox[0] + bbox[2] / 2)
        bcy = int(bbox[1] + bbox[3] / 2)
        vscale = 0.15
        vex = int(bcx + vx * vscale)
        vey = int(bcy + vy * vscale)
        cv2.arrowedLine(frame, (bcx, bcy), (vex, vey), C_CYAN, 2,
                        cv2.LINE_AA, tipLength=0.3)

    # ── Telemetry panel (bottom-left) ───────────────────────────
    panel_y = h - 155
    _semi_rect(frame, 4, panel_y, 260, h - 4, (0, 0, 0), 0.50)
    ty = panel_y + 18
    lh = 17
    cv2.putText(frame, "SMITH PREDICTOR", (10, ty), FONT, 0.34, C_CYAN, 1,
                cv2.LINE_AA)
    ty += lh
    me_x, me_y = tc.hud_model_err
    cv2.putText(frame, f"Model err: ({me_x:+.0f}, {me_y:+.0f}) px",
                (10, ty), FONT, 0.30, C_WHITE, 1, cv2.LINE_AA)
    ty += lh
    cv2.putText(frame, f"Tau: {tc.hud_tau * 1000:.0f} ms",
                (10, ty), FONT, 0.30, C_WHITE, 1, cv2.LINE_AA)
    ty += lh
    cv2.putText(frame, f"Vel: ({vx:+.0f}, {vy:+.0f}) px/s",
                (10, ty), FONT, 0.30, C_WHITE, 1, cv2.LINE_AA)
    ty += lh
    cv2.putText(frame, f"Lead: ({lx:+.0f}, {ly:+.0f}) px",
                (10, ty), FONT, 0.30, C_WHITE, 1, cv2.LINE_AA)
    ty += lh
    cv2.putText(frame, f"Pitch est: {tc.hud_pitch_est:+.1f} deg",
                (10, ty), FONT, 0.30, C_YELLOW, 1, cv2.LINE_AA)
    ty += lh
    cv2.putText(frame, f"Roll est:  {tc.hud_roll_est:+.1f} deg",
                (10, ty), FONT, 0.30, C_YELLOW, 1, cv2.LINE_AA)
    ty += lh
    cv2.putText(frame, f"Area frac: {tc.hud_area_frac:.4f}",
                (10, ty), FONT, 0.30, C_WHITE, 1, cv2.LINE_AA)

    # ── Stick readouts (bottom-right) ───────────────────────────
    r, p, thr, y_cmd, _ = tc.get_commands()
    panel_x = w - 190
    _semi_rect(frame, panel_x, h - 85, w - 4, h - 4, (0, 0, 0), 0.50)
    ty2 = h - 68
    cv2.putText(frame, f"R:{r:3d} P:{p:3d}", (panel_x + 8, ty2),
                FONT, 0.34, C_GREEN, 1, cv2.LINE_AA)
    ty2 += lh
    cv2.putText(frame, f"T:{thr:3d} Y:{y_cmd:3d}", (panel_x + 8, ty2),
                FONT, 0.34, C_GREEN, 1, cv2.LINE_AA)
    ty2 += lh
    auto_txt = "AUTONOMOUS" if tc.autonomous else "IDLE"
    auto_col = C_GREEN if tc.autonomous else C_DGRAY
    cv2.putText(frame, auto_txt, (panel_x + 8, ty2), FONT, 0.34, auto_col, 1,
                cv2.LINE_AA)

    # ── Bottom legend ───────────────────────────────────────────
    _semi_rect(frame, 0, h - 18, w, h, (0, 0, 0), 0.40)
    legend = ("SPACE=auto  T=takeoff  L=land  E=stop  "
              "1/2/3=speed  Q=quit")
    cv2.putText(frame, legend, (8, h - 4), FONT, 0.26, C_DGRAY, 1,
                cv2.LINE_AA)

    return frame


# ═══════════════════════════════════════════════════════════════════════
#  KEYBOARD HANDLER
# ═══════════════════════════════════════════════════════════════════════

def handle_key(key, tc: TrackingController):
    """Process a key press.  Returns False if quit requested."""
    if key == -1:
        return True

    now = time.monotonic()

    if key in (ord('q'), 27):  # Q or ESC
        return False

    if key == ord(' '):
        tc.autonomous = not tc.autonomous
        if tc.autonomous:
            tc.state = S_SEARCH
            tc.consec_det = 0
            tc.vel_est.reset()
            tc.prev_err_x = tc.prev_err_y = 0.0
            log.info("Autonomy ENABLED")
        else:
            # Return to hover
            with tc.lock:
                tc.out_roll = tc.out_pitch = tc.out_yaw = tc.out_throttle = 128
            log.info("Autonomy DISABLED")
        return True

    if key == ord('t'):
        if not tc.armed:
            tc.armed = True
        tc.set_timed_cmd(0x01, 1.0)
        tc.flying = True
        # ── Bug-fix #1: Suppress tracking during takeoff ascent ──
        # The Z-axis climb shifts the target in the camera frame.
        # Without holdoff the PD controller chases the altitude-induced
        # pixel shift and commands unwanted pitch/roll during ascent.
        tc.manual_until = now + 2.5
        tc.prev_err_x = tc.prev_err_y = 0.0
        tc.vel_est.reset()
        with tc.lock:
            tc.out_roll = tc.out_pitch = tc.out_yaw = tc.out_throttle = 128
        log.info("TAKEOFF (tracking suppressed for 2.5s)")
        return True

    if key == ord('l'):
        tc.set_timed_cmd(0x01, 1.0)
        tc.flying = False
        tc.autonomous = False
        with tc.lock:
            tc.out_roll = tc.out_pitch = tc.out_yaw = tc.out_throttle = 128
        log.info("LAND")
        return True

    if key == ord('e'):
        tc.set_timed_cmd(0x02, 1.0)
        tc.flying = False
        tc.autonomous = False
        with tc.lock:
            tc.out_roll = tc.out_pitch = tc.out_yaw = tc.out_throttle = 128
        log.info("EMERGENCY STOP")
        return True

    if key in (ord('1'), ord('2'), ord('3')):
        idx = key - ord('1')
        scales = [0.30, 0.60, 1.00]
        names  = ["30%", "60%", "100%"]
        tc.speed_scale = scales[idx]
        log.info("Speed → %s", names[idx])
        return True

    # ── Manual stick overrides (WASD + arrows) ─────────────────
    MANUAL_STEP = 40
    moved = False
    with tc.lock:
        if key == ord('w'):
            tc.out_pitch = min(255, 128 + MANUAL_STEP); moved = True
        elif key == ord('s'):
            tc.out_pitch = max(0, 128 - MANUAL_STEP); moved = True
        elif key == ord('d'):
            tc.out_roll = min(255, 128 + MANUAL_STEP); moved = True
        elif key == ord('a'):
            tc.out_roll = max(0, 128 - MANUAL_STEP); moved = True

    if moved:
        tc.manual_until = now + MANUAL_HOLDOFF_S

    return True


# ═══════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="FLOW-UFO Autonomous Tracker")
    parser.add_argument("--model", default=YOLO_MODEL_PATH,
                        help="Path to YOLOv8 model weights")
    parser.add_argument("--source", default=None,
                        help="Video source override (file, webcam index, RTSP)")
    parser.add_argument("--tau", type=float, default=TAU_DEFAULT,
                        help="Latency estimate in seconds")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    # ── Banner ──
    print()
    print("  ╔═══════════════════════════════════════════════════════╗")
    print("  ║  🎯 FLOW-UFO AUTONOMOUS TARGET TRACKER               ║")
    print("  ║  Smith Predictor + Pitch Compensation + Tracking FSM  ║")
    print("  ╠═══════════════════════════════════════════════════════╣")
    print("  ║  SPACE = toggle auto  │  T = takeoff  │  L = land    ║")
    print("  ║  E = emergency stop   │  R = reconnect stream        ║")
    print("  ║  WASD = manual override │  1/2/3 = speed │  Q = quit ║")
    print("  ╚═══════════════════════════════════════════════════════╝")
    print()

    # ── Load YOLO model ──
    print(f"  Loading YOLO model: {args.model} ...")
    model = YOLO(args.model)
    log.info("YOLO model loaded: %s", args.model)

    # ── Create controller ──
    tc = TrackingController()
    tc.smith.tau = args.tau
    running = [True]

    # ── Open video stream ──
    source = args.source
    if source is None:
        print(f"  Connecting to drone stream: {STREAM_URL}")
        cap = open_stream()
    else:
        try:
            source = int(source)   # webcam index
        except ValueError:
            pass
        cap = cv2.VideoCapture(source)
        if cap.isOpened():
            log.info("Opened source: %s", source)
        else:
            cap = None

    if cap is None or not cap.isOpened():
        print("  [!] No video source — press R to reconnect or pass --source")
        cap = None

    # ── Start background threads ──
    threading.Thread(target=ctrl_loop, args=(tc, running),
                     daemon=True, name="ctrl").start()
    threading.Thread(target=heartbeat_loop, args=(tc, running),
                     daemon=True, name="hb").start()

    # ── OpenCV window ──
    win_name = "FLOW-UFO Tracker"
    cv2.namedWindow(win_name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win_name, DISPLAY_W, DISPLAY_H)

    fps_time  = time.time()
    fps_count = 0
    fps       = 0.0
    frame_idx = 0

    print("  Ready.  Press SPACE to engage autonomous tracking.\n")

    # ══════════════════════════════════════════════════════════════
    #  MAIN LOOP
    # ══════════════════════════════════════════════════════════════
    while running[0]:
        got_frame = False
        frame = None

        if cap is not None:
            ret, frame = cap.read()
            if ret and frame is not None and frame.size > 0:
                got_frame = True
                frame_idx += 1
            else:
                time.sleep(0.03)

        if not got_frame:
            frame = np.zeros((DISPLAY_H, DISPLAY_W, 3), dtype=np.uint8)
            cv2.putText(frame, "NO VIDEO — press R to reconnect",
                        (180, 270), FONT, 0.6, C_RED, 2, cv2.LINE_AA)

        raw_h, raw_w = frame.shape[:2]

        # ── YOLO detection (every Nth frame) ────────────────────
        bbox = None
        if got_frame and tc.autonomous and frame_idx % YOLO_EVERY_N == 0:
            results = model.predict(
                frame,
                conf=YOLO_CONF,
                iou=YOLO_IOU,
                classes=[YOLO_TARGET_CLS],
                verbose=False,
                device=0,          # GPU
                half=True,         # FP16 on RTX 3070
                imgsz=640,
            )
            if results and len(results[0].boxes) > 0:
                # Pick the largest bounding box (closest / most prominent)
                boxes = results[0].boxes
                areas = (boxes.xywh[:, 2] * boxes.xywh[:, 3]).cpu().numpy()
                best  = int(np.argmax(areas))
                xyxy  = boxes.xyxy[best].cpu().numpy()
                x1, y1, x2, y2 = xyxy
                bbox = (x1, y1, x2 - x1, y2 - y1)  # (x, y, w, h)

        # ── Feed to tracker ─────────────────────────────────────
        if tc.autonomous:
            tc.process(bbox, raw_w, raw_h, time.monotonic())

        # ── Resize for display ──────────────────────────────────
        display = cv2.resize(frame, (DISPLAY_W, DISPLAY_H))

        # Scale bbox coordinates for HUD drawing
        sx = DISPLAY_W / raw_w
        sy = DISPLAY_H / raw_h
        if tc.hud_bbox is not None:
            bx, by, bw, bh = tc.hud_bbox
            tc.hud_bbox = (bx * sx, by * sy, bw * sx, bh * sy)
        # Scale corrected / lead too
        cx, cy = tc.hud_corrected
        tc.hud_corrected = (cx * sx, cy * sy)
        lx, ly = tc.hud_lead
        tc.hud_lead = (lx * sx, ly * sy)

        # ── Draw HUD ───────────────────────────────────────────
        display = draw_tracking_hud(display, tc, fps)

        # ── FPS counter ─────────────────────────────────────────
        fps_count += 1
        now_t = time.time()
        if now_t - fps_time >= 1.0:
            fps = fps_count / (now_t - fps_time)
            fps_count = 0
            fps_time = now_t

        cv2.imshow(win_name, display)

        # ── Keyboard ────────────────────────────────────────────
        key = cv2.waitKeyEx(1)

        if key == ord('r'):
            # Reconnect stream
            if cap is not None:
                cap.release()
            if args.source is None:
                cap = open_stream()
            else:
                try:
                    src = int(args.source)
                except ValueError:
                    src = args.source
                cap = cv2.VideoCapture(src)
            if cap and cap.isOpened():
                log.info("Reconnected")
            else:
                cap = None
            continue

        if not handle_key(key, tc):
            break

    # ══════════════════════════════════════════════════════════════
    #  SHUTDOWN
    # ══════════════════════════════════════════════════════════════
    running[0] = False

    # Auto-land if still flying
    if tc.flying:
        print("  Auto-landing...")
        tc.set_timed_cmd(0x01, 1.0)
        with tc.lock:
            tc.out_roll = tc.out_pitch = tc.out_yaw = tc.out_throttle = 128
        time.sleep(1.2)

    if cap is not None:
        cap.release()
    cv2.destroyAllWindows()

    log.info("=== Tracker shutdown ===")
    log.info("TX=%d  HB=%d  Frames=%d", tc.tx_count, tc.hb_count, frame_idx)
    print(f"\n  Session: {tc.tx_count} TX, {tc.hb_count} HB, {frame_idx} frames")
    print(f"  Debug log: {LOG_PATH}\n")


if __name__ == "__main__":
    main()
