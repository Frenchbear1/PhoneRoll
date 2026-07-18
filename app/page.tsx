"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";

type Screen = "measure" | "calibration" | "settings";
type Orientation = "face_up" | "face_down" | "top_edge" | "bottom_edge" | "left_edge" | "right_edge" | "unknown";
type EngineState = "idle" | "arming" | "ready" | "moving" | "cooldown";
type CalibrationPhase = "scale" | "start" | "turns" | "complete";
type Vec = { x: number; y: number; z: number };
type MotionSample = { gravity: Vec; acceleration: Vec; rotation: Vec; orientation: Orientation; gravityMagnitude: number; at: number };
type ApplePermissionEvent = { requestPermission?: () => Promise<"granted" | "denied"> };

const STORE = {
  calibration: "phoneroll.tape-calibration.v2",
  rulerScale: "phoneroll.ruler-scale.v1",
};

const TAPE_INCHES = 60;
const TAPE_TICKS = Array.from({ length: TAPE_INCHES * 16 + 1 }, (_, division) => ({
  division,
  inch: Math.floor(division / 16),
  fraction: division % 16,
}));

const blank = (): Vec => ({ x: 0, y: 0, z: 0 });
const magnitude = (v: Vec) => Math.hypot(v.x, v.y, v.z);
const normalize = (v: Vec): Vec => {
  const length = magnitude(v) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec, b: Vec): Vec => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const safeNumber = (value: number | null | undefined) => Number.isFinite(value) ? Number(value) : 0;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const orientationFromGravity = (vector: Vec): Orientation => {
  const v = normalize(vector);
  const choices = [
    [Math.abs(v.x), v.x > 0 ? "right_edge" : "left_edge"],
    [Math.abs(v.y), v.y > 0 ? "bottom_edge" : "top_edge"],
    [Math.abs(v.z), v.z > 0 ? "face_up" : "face_down"],
  ] as const;
  const [largest, name] = choices.sort((a, b) => b[0] - a[0])[0];
  return largest > 0.8 ? name : "unknown";
};

const loadJSON = <T,>(key: string, fallback: T): T => {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) as T : fallback;
  } catch {
    return fallback;
  }
};

/** Kept off-screen: only settled, perpendicular quarter turns advance the tape. */
class QuarterTurnEngine {
  private state: EngineState = "idle";
  private source: { orientation: Orientation; vector: Vec } | null = null;
  private candidate: { orientation: Orientation; since: number; vector: Vec } | null = null;
  private rollAxis: Vec | null = null;
  private startedAt = 0;
  private cooldownUntil = 0;
  private accepted = 0;

  reset() {
    this.state = "arming";
    this.source = null;
    this.candidate = null;
    this.rollAxis = null;
    this.startedAt = 0;
    this.cooldownUntil = 0;
    this.accepted = 0;
  }

  stop() {
    this.state = "idle";
    this.source = null;
    this.candidate = null;
  }

  getAccepted() { return this.accepted; }

  private noteCandidate(sample: MotionSample, stable: boolean) {
    if (!stable || sample.orientation === "unknown") {
      this.candidate = null;
      return false;
    }
    const current = normalize(sample.gravity);
    if (this.candidate?.orientation !== sample.orientation) {
      this.candidate = { orientation: sample.orientation, since: sample.at, vector: current };
      return false;
    }
    this.candidate.vector = normalize({
      x: this.candidate.vector.x * 0.72 + current.x * 0.28,
      y: this.candidate.vector.y * 0.72 + current.y * 0.28,
      z: this.candidate.vector.z * 0.72 + current.z * 0.28,
    });
    return sample.at - this.candidate.since >= 260;
  }

  private rearm() {
    this.state = "arming";
    this.source = null;
    this.candidate = null;
  }

  update(sample: MotionSample) {
    if (this.state === "idle") return false;
    const acceleration = magnitude(sample.acceleration);
    const rotation = magnitude(sample.rotation);
    const gravityOK = sample.gravityMagnitude >= 7.2 && sample.gravityMagnitude <= 12.5;
    const stable = gravityOK && sample.orientation !== "unknown" && acceleration < 1.25 && rotation < 75;
    const unstableDuringRoll = (!gravityOK && sample.gravityMagnitude > 0.2) || acceleration > 5.7 || rotation > 620;
    if ((this.state === "moving" || this.state === "cooldown") && unstableDuringRoll) {
      this.rearm();
      return false;
    }
    const stableLongEnough = this.noteCandidate(sample, stable);

    if (this.state === "arming") {
      if (stableLongEnough && this.candidate) {
        this.source = { orientation: this.candidate.orientation, vector: this.candidate.vector };
        this.state = "ready";
      }
      return false;
    }
    if (this.state === "ready") {
      if (!stable || sample.orientation !== this.source?.orientation) {
        this.state = "moving";
        this.startedAt = sample.at;
        this.candidate = null;
      }
      return false;
    }
    if (this.state === "cooldown") {
      if (!stable) { this.rearm(); return false; }
      if (sample.at >= this.cooldownUntil && stableLongEnough && this.candidate) {
        this.source = { orientation: this.candidate.orientation, vector: this.candidate.vector };
        this.state = "ready";
      }
      return false;
    }
    if (this.state !== "moving" || !this.source) return false;
    const elapsed = sample.at - this.startedAt;
    if (elapsed > 2600) { this.rearm(); return false; }
    if (!stableLongEnough || !this.candidate) return false;
    const alignment = dot(this.source.vector, this.candidate.vector);
    if (this.candidate.orientation === this.source.orientation || alignment < -0.55 || Math.abs(alignment) > 0.38 || elapsed < 95) {
      this.rearm();
      return false;
    }
    const axis = normalize(cross(this.source.vector, this.candidate.vector));
    if (this.rollAxis && dot(axis, this.rollAxis) < 0.42) { this.rearm(); return false; }
    this.rollAxis ??= axis;
    this.accepted += 1;
    this.state = "cooldown";
    this.cooldownUntil = sample.at + 320;
    return true;
  }
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("measure");
  const [menuOpen, setMenuOpen] = useState(false);
  const [rulerScale, setRulerScale] = useState(3.78);
  const [calibration, setCalibration] = useState<number[]>([0, 0, 0, 0]);
  const [tapeOffset, setTapeOffset] = useState(16);
  const [reversed, setReversed] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [calibrationPhase, setCalibrationPhase] = useState<CalibrationPhase>("scale");
  const [turnIndex, setTurnIndex] = useState(0);
  const [lastAlignment, setLastAlignment] = useState(0);
  const [calibrationNotice, setCalibrationNotice] = useState("");

  const detector = useRef(new QuarterTurnEngine());
  const calibrationRef = useRef(calibration);
  const rulerScaleRef = useRef(rulerScale);
  const reversedRef = useRef(reversed);
  const motionEnabledRef = useRef(motionEnabled);

  useEffect(() => {
    const savedScale = Number(localStorage.getItem(STORE.rulerScale) ?? 3.78);
    const savedCalibration = loadJSON<number[]>(STORE.calibration, [0, 0, 0, 0]);
    setRulerScale(clamp(Number.isFinite(savedScale) ? savedScale : 3.78, 2.5, 10));
    setCalibration(savedCalibration.length === 4 ? savedCalibration : [0, 0, 0, 0]);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => { calibrationRef.current = calibration; localStorage.setItem(STORE.calibration, JSON.stringify(calibration)); }, [calibration]);
  useEffect(() => { rulerScaleRef.current = rulerScale; localStorage.setItem(STORE.rulerScale, String(rulerScale)); }, [rulerScale]);
  useEffect(() => { reversedRef.current = reversed; }, [reversed]);
  useEffect(() => { motionEnabledRef.current = motionEnabled; }, [motionEnabled]);

  useEffect(() => {
    const readMotion = (event: DeviceMotionEvent) => {
      if (!motionEnabledRef.current) return;
      const gravity = event.accelerationIncludingGravity
        ? { x: safeNumber(event.accelerationIncludingGravity.x), y: safeNumber(event.accelerationIncludingGravity.y), z: safeNumber(event.accelerationIncludingGravity.z) }
        : blank();
      const acceleration = event.acceleration
        ? { x: safeNumber(event.acceleration.x), y: safeNumber(event.acceleration.y), z: safeNumber(event.acceleration.z) }
        : blank();
      const rotation = event.rotationRate
        ? { x: safeNumber(event.rotationRate.alpha), y: safeNumber(event.rotationRate.beta), z: safeNumber(event.rotationRate.gamma) }
        : blank();
      const sample: MotionSample = {
        gravity,
        acceleration,
        rotation,
        orientation: orientationFromGravity(gravity),
        gravityMagnitude: magnitude(gravity),
        at: event.timeStamp || performance.now(),
      };
      if (!detector.current.update(sample)) return;
      const saved = calibrationRef.current;
      if (saved.some((value) => value <= 0)) return;
      const corner = saved[(detector.current.getAccepted() - 1) % 4];
      const movement = (corner / 25.4) * rulerScaleRef.current * 25.4;
      setTapeOffset((current) => current + (reversedRef.current ? movement : -movement));
    };
    window.addEventListener("devicemotion", readMotion, true);
    return () => window.removeEventListener("devicemotion", readMotion, true);
  }, []);

  const enableMotion = async () => {
    if (motionEnabledRef.current) return;
    try {
      const motion = DeviceMotionEvent as unknown as ApplePermissionEvent;
      const orientation = DeviceOrientationEvent as unknown as ApplePermissionEvent;
      const requested = [motion, orientation].filter((event) => typeof event.requestPermission === "function");
      if (requested.length) {
        const decisions = await Promise.all(requested.map((event) => event.requestPermission?.()));
        if (decisions.some((decision) => decision !== "granted")) return;
      }
      detector.current.reset();
      setMotionEnabled(true);
    } catch {
      // The tape stays readable even when a browser does not expose motion permission.
    }
  };

  const openCalibration = () => {
    detector.current.stop();
    setMotionEnabled(false);
    setMenuOpen(false);
    setCalibrationPhase("scale");
    setTurnIndex(0);
    setCalibrationNotice("");
    setScreen("calibration");
  };
  const openSettings = () => { detector.current.stop(); setMotionEnabled(false); setMenuOpen(false); setScreen("settings"); };
  const saveScale = () => { setCalibrationNotice(""); setCalibrationPhase("start"); };
  const captureStart = () => { setLastAlignment(tapeOffset); setCalibrationNotice(""); setTurnIndex(0); setCalibrationPhase("turns"); };
  const saveCorner = () => {
    const distanceMm = Math.abs(tapeOffset - lastAlignment) / rulerScale;
    if (distanceMm < 8) {
      setCalibrationNotice("Drag the tape to a new matching mark before saving this corner.");
      return;
    }
    const next = [...calibration];
    next[turnIndex] = distanceMm;
    setCalibration(next);
    setLastAlignment(tapeOffset);
    setCalibrationNotice("");
    if (turnIndex === 3) setCalibrationPhase("complete");
    else setTurnIndex(turnIndex + 1);
  };
  const resetCalibration = () => {
    setCalibration([0, 0, 0, 0]);
    setCalibrationPhase("scale");
    setTurnIndex(0);
    setCalibrationNotice("");
  };
  const directionToggle = () => {
    setReversed((current) => !current);
    if (motionEnabledRef.current) detector.current.reset();
  };

  const sharedTape = (draggable: boolean) => <TapeRuler
    offset={tapeOffset}
    scaleMm={rulerScale}
    reversed={reversed}
    draggable={draggable}
    showEnableHint={screen === "measure" && !motionEnabled}
    onOffset={setTapeOffset}
    onReverse={directionToggle}
    onEnableMotion={screen === "measure" ? enableMotion : () => undefined}
  />;

  return <main className="app-shell">
    {screen === "measure" && <MeasureScreen menuOpen={menuOpen} onMenu={() => setMenuOpen((open) => !open)} onCalibrate={openCalibration} onSettings={openSettings}>{sharedTape(false)}</MeasureScreen>}
    {screen === "calibration" && <CalibrationScreen phase={calibrationPhase} turnIndex={turnIndex} notice={calibrationNotice} rulerScale={rulerScale} calibration={calibration} onScale={(value) => setRulerScale(clamp(value, 2.5, 10))} onSaveScale={saveScale} onCaptureStart={captureStart} onSaveCorner={saveCorner} onBack={() => setScreen("measure")} onFinish={() => setScreen("measure")}>{sharedTape(true)}</CalibrationScreen>}
    {screen === "settings" && <SettingsScreen calibrated={calibration.every((value) => value > 0)} onReset={resetCalibration} onBack={() => setScreen("measure")} />}
  </main>;
}

function MeasureScreen({ menuOpen, onMenu, onCalibrate, onSettings, children }: { menuOpen: boolean; onMenu: () => void; onCalibrate: () => void; onSettings: () => void; children: ReactNode }) {
  return <section className="measure-screen">
    <button className="home-menu-button" aria-label="Open ruler options" aria-expanded={menuOpen} onClick={onMenu}>•••</button>
    {menuOpen && <div className="home-menu"><button onClick={onCalibrate}>Calibrate tape</button><button onClick={onSettings}>Settings</button></div>}
    {children}
  </section>;
}

function CalibrationScreen({ phase, turnIndex, notice, rulerScale, calibration, onScale, onSaveScale, onCaptureStart, onSaveCorner, onBack, onFinish, children }: {
  phase: CalibrationPhase; turnIndex: number; notice: string; rulerScale: number; calibration: number[]; onScale: (value: number) => void; onSaveScale: () => void; onCaptureStart: () => void; onSaveCorner: () => void; onBack: () => void; onFinish: () => void; children: ReactNode;
}) {
  const steps = {
    scale: <><p className="step-count">Step 1 of 3</p><h1>Match the tape to a real tape measure.</h1><p>Adjust the scale until the inch and fraction marks on the yellow tape line up with your real tape. The slider only changes its physical size.</p><input className="scale-slider" aria-label="Tape scale" type="range" min="2.5" max="10" step="0.01" value={rulerScale} onChange={(event) => onScale(Number(event.target.value))} /><button className="action-button" onClick={onSaveScale}>Save tape size</button></>,
    start: <><p className="step-count">Step 2 of 3</p><h1>Set the starting alignment.</h1><p>Put any phone edge at the zero of a real ruler. Drag the yellow tape until a shared whole-inch mark lines up—2″ to 2″ is a good choice.</p><button className="action-button" onClick={onCaptureStart}>Save starting alignment</button></>,
    turns: <><p className="step-count">Step 3 of 3 · corner {turnIndex + 1} of 4</p><h1>Flip once, then align the tape again.</h1><p>Roll the phone one quarter turn. Drag the yellow tape until its marks match the real ruler again, then save this corner. Repeat for all four corners.</p><div className="corner-progress">{calibration.map((value, index) => <span className={index < turnIndex || (phase === "complete" && value > 0) ? "saved" : ""} key={index}>{index + 1}</span>)}</div><button className="action-button" onClick={onSaveCorner}>Save this corner</button></>,
    complete: <><p className="step-count">Calibration complete</p><h1>The tape is ready to roll.</h1><p>All four corner distances are saved. Return to the ruler, tap it once to allow motion, then roll the phone in the selected direction.</p><div className="corner-progress">{calibration.map((_, index) => <span className="saved" key={index}>{index + 1}</span>)}</div><button className="action-button" onClick={onFinish}>Use the tape</button></>,
  };
  return <section className="calibration-screen"><header className="page-header"><button onClick={onBack}>‹ Ruler</button><span>Calibration</span></header><div className="calibration-card">{steps[phase]}{notice && <p className="calibration-notice">{notice}</p>}</div>{children}</section>;
}

function SettingsScreen({ calibrated, onReset, onBack }: { calibrated: boolean; onReset: () => void; onBack: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return <section className="settings-screen"><header className="page-header"><button onClick={onBack}>‹ Ruler</button><span>Settings</span></header><div className="settings-card"><h1>Tape calibration</h1><p>{calibrated ? "Four corner measurements are saved on this device." : "No complete tape calibration is saved yet."}</p>{confirming ? <div className="reset-row"><button className="action-button danger" onClick={() => { onReset(); setConfirming(false); }}>Reset calibration</button><button className="plain-button" onClick={() => setConfirming(false)}>Cancel</button></div> : <button className="plain-button danger-text" onClick={() => setConfirming(true)}>Reset calibration</button>}</div></section>;
}

function TapeRuler({ offset, scaleMm, reversed, draggable, showEnableHint, onOffset, onReverse, onEnableMotion }: { offset: number; scaleMm: number; reversed: boolean; draggable: boolean; showEnableHint: boolean; onOffset: (value: number) => void; onReverse: () => void; onEnableMotion: () => void }) {
  const drag = useRef<{ pointerId: number; startX: number; startOffset: number } | null>(null);
  const pixelsPerInch = scaleMm * 25.4;
  const direction = reversed ? -1 : 1;
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    onEnableMotion();
    if (!draggable) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startOffset: offset };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    onOffset(drag.current.startOffset + event.clientX - drag.current.startX);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };
  return <aside className="tape-ruler" aria-label="Construction tape ruler">
    <button className="direction-button" aria-label="Reverse ruler direction" onClick={onReverse}><span>{reversed ? "←" : "→"}</span></button>
    <div className={`tape-viewport ${draggable ? "is-draggable" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {showEnableHint && <span className="motion-hint">Tap tape to enable rolling</span>}
      {TAPE_TICKS.map(({ division, inch, fraction }) => <TapeTick key={division} x={offset + direction * (division / 16) * pixelsPerInch} inch={inch} fraction={fraction} />)}
    </div>
  </aside>;
}

function TapeTick({ x, inch, fraction }: { x: number; inch: number; fraction: number }) {
  const kind = fraction === 0 ? "inch" : fraction % 8 === 0 ? "half" : fraction % 4 === 0 ? "quarter" : fraction % 2 === 0 ? "eighth" : "sixteenth";
  const fractionText: Record<number, string> = { 0: String(inch), 2: "⅛", 4: "¼", 6: "⅜", 8: "½", 10: "⅝", 12: "¾", 14: "⅞" };
  const label = fractionText[fraction] ?? "";
  return <div className={`tape-tick ${kind}`} style={{ left: x } as CSSProperties}><span>{label}</span></div>;
}
