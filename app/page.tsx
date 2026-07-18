"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Screen = "measure" | "calibration" | "debug" | "settings";
type Unit = "in" | "mm";
type EngineState = "idle" | "arming" | "ready" | "in_motion" | "cooldown" | "rejected";
type OrientationKey =
  | "face_up"
  | "face_down"
  | "top_edge"
  | "bottom_edge"
  | "left_edge"
  | "right_edge"
  | "unknown";

type Vec = { x: number; y: number; z: number };
type MotionReading = {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  acceleration: Vec;
  gravity: Vec;
  rotation: Vec;
  gravityMagnitude: number;
  orientation: OrientationKey;
  at: number;
};

type Settings = { unit: Unit; sound: boolean; haptics: boolean };
type EngineSnapshot = {
  state: EngineState;
  orientation: OrientationKey;
  accepted: number;
  rejected: number;
  reason: string;
};

type ApplePermissionEvent = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const STORE = {
  calibration: "phoneroll.calibration.v1",
  settings: "phoneroll.settings.v1",
  rulerScale: "phoneroll.ruler-scale.v1",
};

const blankVector = (): Vec => ({ x: 0, y: 0, z: 0 });
const initialReading = (): MotionReading => ({
  alpha: null,
  beta: null,
  gamma: null,
  acceleration: blankVector(),
  gravity: blankVector(),
  rotation: blankVector(),
  gravityMagnitude: 0,
  orientation: "unknown",
  at: 0,
});

const initialEngine = (): EngineSnapshot => ({
  state: "idle",
  orientation: "unknown",
  accepted: 0,
  rejected: 0,
  reason: "Waiting to start",
});

const safeNumber = (value: number | null | undefined) =>
  Number.isFinite(value) ? Number(value) : 0;
const magnitude = (v: Vec) => Math.hypot(v.x, v.y, v.z);
const normalize = (v: Vec): Vec => {
  const length = magnitude(v) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec, b: Vec): Vec => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const clone = (v: Vec): Vec => ({ ...v });

const orientationLabels: Record<OrientationKey, string> = {
  face_up: "Face up",
  face_down: "Face down",
  top_edge: "Top edge",
  bottom_edge: "Bottom edge",
  left_edge: "Left edge",
  right_edge: "Right edge",
  unknown: "Finding gravity",
};

const orientationFromGravity = (vector: Vec): OrientationKey => {
  const v = normalize(vector);
  const values = [
    [Math.abs(v.x), v.x > 0 ? "right_edge" : "left_edge"],
    [Math.abs(v.y), v.y > 0 ? "bottom_edge" : "top_edge"],
    [Math.abs(v.z), v.z > 0 ? "face_up" : "face_down"],
  ] as const;
  const [largest, orientation] = values.sort((a, b) => b[0] - a[0])[0];
  return largest > 0.8 ? orientation : "unknown";
};

/**
 * A deliberately conservative, gravity-vector based quarter-turn detector.
 * It does not count a change until it has a stable cardinal source, a real
 * motion interval, and a separately stable orthogonal target.
 */
class QuarterTurnEngine {
  private state: EngineState = "idle";
  private source: { orientation: OrientationKey; vector: Vec } | null = null;
  private candidate: { orientation: OrientationKey; since: number; vector: Vec } | null = null;
  private rollAxis: Vec | null = null;
  private startedAt = 0;
  private cooldownUntil = 0;
  private accepted = 0;
  private rejected = 0;
  private reason = "Waiting to start";

  reset() {
    this.state = "arming";
    this.source = null;
    this.candidate = null;
    this.rollAxis = null;
    this.startedAt = 0;
    this.cooldownUntil = 0;
    this.accepted = 0;
    this.rejected = 0;
    this.reason = "Hold one side still to arm";
  }

  stop() {
    this.state = "idle";
    this.source = null;
    this.candidate = null;
    this.reason = "Measurement stopped";
  }

  getSnapshot(orientation: OrientationKey): EngineSnapshot {
    return {
      state: this.state,
      orientation,
      accepted: this.accepted,
      rejected: this.rejected,
      reason: this.reason,
    };
  }

  private setCandidate(reading: MotionReading, stable: boolean) {
    if (!stable || reading.orientation === "unknown") {
      this.candidate = null;
      return false;
    }
    if (this.candidate?.orientation === reading.orientation) {
      this.candidate.vector = normalize({
        x: this.candidate.vector.x * 0.72 + normalize(reading.gravity).x * 0.28,
        y: this.candidate.vector.y * 0.72 + normalize(reading.gravity).y * 0.28,
        z: this.candidate.vector.z * 0.72 + normalize(reading.gravity).z * 0.28,
      });
      return reading.at - this.candidate.since >= 260;
    }
    this.candidate = {
      orientation: reading.orientation,
      since: reading.at,
      vector: normalize(reading.gravity),
    };
    return false;
  }

  private reject(reason: string) {
    this.rejected += 1;
    this.reason = reason;
    this.state = "rejected";
    this.source = null;
    this.candidate = null;
  }

  update(reading: MotionReading) {
    const acceleration = magnitude(reading.acceleration);
    const rotation = magnitude(reading.rotation);
    const gravityOK = reading.gravityMagnitude >= 7.2 && reading.gravityMagnitude <= 12.5;
    const lifted = !gravityOK && reading.gravityMagnitude > 0.2;
    const shaking = acceleration > 5.7 || rotation > 620;
    const stable =
      gravityOK &&
      reading.orientation !== "unknown" &&
      acceleration < 1.25 &&
      rotation < 75;

    if (this.state === "idle") return { accepted: false, rejected: false };

    if ((this.state === "in_motion" || this.state === "cooldown") && lifted) {
      this.reject("Rejected: phone was lifted");
      return { accepted: false, rejected: true };
    }
    if ((this.state === "in_motion" || this.state === "cooldown") && shaking) {
      this.reject("Rejected: shaking exceeded threshold");
      return { accepted: false, rejected: true };
    }

    const stableLongEnough = this.setCandidate(reading, stable);

    if (this.state === "arming" || this.state === "rejected") {
      if (stableLongEnough && this.candidate) {
        this.source = { orientation: this.candidate.orientation, vector: clone(this.candidate.vector) };
        this.state = "ready";
        this.reason = "Armed — roll one quarter turn";
      }
      return { accepted: false, rejected: false };
    }

    if (this.state === "ready") {
      const sameSource = stable && reading.orientation === this.source?.orientation;
      if (!sameSource) {
        this.state = "in_motion";
        this.startedAt = reading.at;
        this.candidate = null;
        this.reason = "Motion detected — waiting for a stable 90° stop";
      }
      return { accepted: false, rejected: false };
    }

    if (this.state === "cooldown") {
      if (!stable) {
        this.reject("Rejected: flip repeated before settling");
        return { accepted: false, rejected: true };
      }
      if (reading.at >= this.cooldownUntil && stableLongEnough && this.candidate) {
        this.source = { orientation: this.candidate.orientation, vector: clone(this.candidate.vector) };
        this.state = "ready";
        this.reason = "Ready for next quarter turn";
      }
      return { accepted: false, rejected: false };
    }

    if (this.state === "in_motion") {
      const elapsed = reading.at - this.startedAt;
      if (elapsed > 2600) {
        this.reject("Rejected: turn took too long to settle");
        return { accepted: false, rejected: true };
      }
      if (!stableLongEnough || !this.candidate || !this.source) {
        return { accepted: false, rejected: false };
      }
      const alignment = dot(this.source.vector, this.candidate.vector);
      if (this.candidate.orientation === this.source.orientation) {
        this.reject("Rejected: duplicate orientation");
        return { accepted: false, rejected: true };
      }
      if (alignment < -0.55) {
        this.reject("Rejected: 180° change, not a quarter turn");
        return { accepted: false, rejected: true };
      }
      if (Math.abs(alignment) > 0.38 || elapsed < 95) {
        this.reject("Rejected: incomplete quarter-turn transition");
        return { accepted: false, rejected: true };
      }
      const axis = normalize(cross(this.source.vector, this.candidate.vector));
      if (this.rollAxis && dot(axis, this.rollAxis) < 0.42) {
        this.reject("Rejected: reverse or off-axis roll");
        return { accepted: false, rejected: true };
      }
      this.rollAxis ??= axis;
      this.accepted += 1;
      this.state = "cooldown";
      this.cooldownUntil = reading.at + 320;
      this.reason = "Accepted — hold stable before the next roll";
      return { accepted: true, rejected: false };
    }
    return { accepted: false, rejected: false };
  }
}

const loadJSON = <T,>(key: string, fallback: T): T => {
  try {
    const stored = localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
};
const round = (number: number, places = 1) => Number(number.toFixed(places));
const displayValue = (mm: number, unit: Unit, places = 2) =>
  unit === "in" ? (mm / 25.4).toFixed(places) : mm.toFixed(places === 2 ? 1 : places);
const distanceLabel = (mm: number, unit: Unit, places = 2) =>
  `${displayValue(mm, unit, places)} ${unit === "in" ? "in" : "mm"}`;
const sensorValue = (value: number | null, places = 1) =>
  value === null ? "—" : value.toFixed(places);

export default function Home() {
  const [screen, setScreen] = useState<Screen>("measure");
  const [settings, setSettings] = useState<Settings>({ unit: "in", sound: true, haptics: true });
  const [calibration, setCalibration] = useState<number[]>([0, 0, 0, 0]);
  const [rulerScale, setRulerScale] = useState(3.78);
  const [reading, setReading] = useState<MotionReading>(initialReading);
  const [engine, setEngine] = useState<EngineSnapshot>(initialEngine);
  const [measuring, setMeasuring] = useState(false);
  const [distance, setDistance] = useState(0);
  const [permissionStatus, setPermissionStatus] = useState("Sensor idle");
  const [calStep, setCalStep] = useState(0);
  const [calMarker, setCalMarker] = useState(69.9);
  const [confirmReset, setConfirmReset] = useState(false);

  const detector = useRef(new QuarterTurnEngine());
  const settingsRef = useRef(settings);
  const calibrationRef = useRef(calibration);
  const distanceRef = useRef(distance);
  const measuringRef = useRef(measuring);
  const lastUIUpdate = useRef(0);
  const lastReadingUpdate = useRef(0);
  const toneContext = useRef<AudioContext | null>(null);

  useEffect(() => {
    const savedSettings = loadJSON<Settings>(STORE.settings, { unit: "in", sound: true, haptics: true });
    const savedCalibration = loadJSON<number[]>(STORE.calibration, [0, 0, 0, 0]);
    const savedScale = Number(localStorage.getItem(STORE.rulerScale) ?? 3.78);
    setSettings(savedSettings);
    setCalibration(savedCalibration.length === 4 ? savedCalibration : [0, 0, 0, 0]);
    setRulerScale(Number.isFinite(savedScale) ? savedScale : 3.78);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem(STORE.settings, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    calibrationRef.current = calibration;
    localStorage.setItem(STORE.calibration, JSON.stringify(calibration));
  }, [calibration]);
  useEffect(() => {
    localStorage.setItem(STORE.rulerScale, String(rulerScale));
  }, [rulerScale]);
  useEffect(() => {
    distanceRef.current = distance;
  }, [distance]);
  useEffect(() => {
    measuringRef.current = measuring;
  }, [measuring]);

  useEffect(() => {
    const readOrientation = (event: DeviceOrientationEvent) => {
      setReading((previous) => ({
        ...previous,
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
      }));
    };
    const readMotion = (event: DeviceMotionEvent) => {
      const rawGravity = event.accelerationIncludingGravity;
      const gravity: Vec = rawGravity
        ? { x: safeNumber(rawGravity.x), y: safeNumber(rawGravity.y), z: safeNumber(rawGravity.z) }
        : blankVector();
      const acceleration: Vec = event.acceleration
        ? {
            x: safeNumber(event.acceleration.x),
            y: safeNumber(event.acceleration.y),
            z: safeNumber(event.acceleration.z),
          }
        : blankVector();
      const rotation: Vec = event.rotationRate
        ? {
            x: safeNumber(event.rotationRate.alpha),
            y: safeNumber(event.rotationRate.beta),
            z: safeNumber(event.rotationRate.gamma),
          }
        : blankVector();
      const next: MotionReading = {
        ...initialReading(),
        gravity,
        acceleration,
        rotation,
        gravityMagnitude: magnitude(gravity),
        orientation: orientationFromGravity(gravity),
        at: event.timeStamp || performance.now(),
      };
      if (measuringRef.current) {
        const result = detector.current.update(next);
        const snapshot = detector.current.getSnapshot(next.orientation);
        if (result.accepted) {
          const index = (snapshot.accepted - 1) % 4;
          const increment = calibrationRef.current[index] || 0;
          const nextDistance = distanceRef.current + increment;
          distanceRef.current = nextDistance;
          setDistance(nextDistance);
          const activeSettings = settingsRef.current;
          if (activeSettings.haptics && navigator.vibrate) navigator.vibrate(18);
          if (activeSettings.sound) {
            try {
              toneContext.current ??= new AudioContext();
              const oscillator = toneContext.current.createOscillator();
              const gain = toneContext.current.createGain();
              oscillator.frequency.value = 880;
              gain.gain.setValueAtTime(0.04, toneContext.current.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.001, toneContext.current.currentTime + 0.08);
              oscillator.connect(gain).connect(toneContext.current.destination);
              oscillator.start();
              oscillator.stop(toneContext.current.currentTime + 0.08);
            } catch {
              // Sound is optional; a sensor reading must never fail because audio is blocked.
            }
          }
        }
        if (result.accepted || result.rejected || next.at - lastUIUpdate.current > 80) {
          setEngine(snapshot);
          lastUIUpdate.current = next.at;
        }
      }
      if (next.at - lastReadingUpdate.current > 80) {
        setReading((previous) => ({ ...next, alpha: previous.alpha, beta: previous.beta, gamma: previous.gamma }));
        lastReadingUpdate.current = next.at;
      }
    };
    window.addEventListener("deviceorientation", readOrientation, true);
    window.addEventListener("devicemotion", readMotion, true);
    return () => {
      window.removeEventListener("deviceorientation", readOrientation, true);
      window.removeEventListener("devicemotion", readMotion, true);
    };
  }, []);

  const distanceInUnit = useMemo(() => displayValue(distance, settings.unit, 2), [distance, settings.unit]);
  const calibrationReady = calibration.every((value) => value > 0);
  const rulerTicks = useMemo(() => Array.from({ length: 45 }, (_, i) => i * 5), []);

  const requestPermissionAndStart = async () => {
    try {
      const requests: Promise<unknown>[] = [];
      const motion = DeviceMotionEvent as unknown as ApplePermissionEvent;
      const orientation = DeviceOrientationEvent as unknown as ApplePermissionEvent;
      if (typeof motion.requestPermission === "function") requests.push(motion.requestPermission());
      if (typeof orientation.requestPermission === "function") requests.push(orientation.requestPermission());
      if (requests.length) {
        const result = await Promise.all(requests);
        if (result.some((item) => item !== "granted")) {
          setPermissionStatus("Motion permission denied");
          return;
        }
      }
      detector.current.reset();
      setDistance(0);
      setEngine(detector.current.getSnapshot(reading.orientation));
      setMeasuring(true);
      setPermissionStatus("Motion permission granted");
    } catch {
      setPermissionStatus("Motion permission unavailable");
    }
  };

  const stopMeasurement = () => {
    detector.current.stop();
    setMeasuring(false);
    setEngine(detector.current.getSnapshot(reading.orientation));
  };
  const resetMeasurement = () => {
    setDistance(0);
    if (measuringRef.current) {
      detector.current.reset();
      setEngine(detector.current.getSnapshot(reading.orientation));
    }
  };
  const saveCalibrationTurn = () => {
    const next = [...calibration];
    next[calStep] = calMarker;
    setCalibration(next);
    if (calStep < 3) {
      setCalStep(calStep + 1);
      setCalMarker(next[calStep + 1] || calMarker);
    }
  };
  const resetCalibration = () => {
    setCalibration([0, 0, 0, 0]);
    setCalStep(0);
    setCalMarker(69.9);
    setConfirmReset(false);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ENGINEERING PROTOTYPE</p>
          <h1>Phone<span>Roll</span></h1>
        </div>
        <div className={`status-dot ${measuring ? "is-live" : ""}`} aria-label={permissionStatus}>
          <span /> {measuring ? "LIVE" : "OFF"}
        </div>
      </header>

      <section className="content" aria-live="polite">
        {screen === "measure" && (
          <MeasureScreen
            distance={distanceInUnit}
            unit={settings.unit}
            measuring={measuring}
            engine={engine}
            calibrated={calibrationReady}
            onStart={requestPermissionAndStart}
            onStop={stopMeasurement}
            onReset={resetMeasurement}
          />
        )}
        {screen === "calibration" && (
          <CalibrationScreen
            unit={settings.unit}
            calibration={calibration}
            calStep={calStep}
            calMarker={calMarker}
            rulerScale={rulerScale}
            ticks={rulerTicks}
            onMarker={setCalMarker}
            onScale={setRulerScale}
            onSave={saveCalibrationTurn}
            onRestart={() => {
              setCalStep(0);
              setCalMarker(calibration[0] || 69.9);
            }}
          />
        )}
        {screen === "debug" && <DebugScreen reading={reading} engine={engine} measuring={measuring} />}
        {screen === "settings" && (
          <SettingsScreen
            settings={settings}
            calibrationReady={calibrationReady}
            confirmReset={confirmReset}
            onSettings={setSettings}
            onReset={() => setConfirmReset(true)}
            onCancel={() => setConfirmReset(false)}
            onConfirm={resetCalibration}
          />
        )}
      </section>

      <nav className="tabbar" aria-label="Primary navigation">
        {(
          [
            ["measure", "Measure"],
            ["calibration", "Calibrate"],
            ["debug", "Debug"],
            ["settings", "Settings"],
          ] as [Screen, string][]
        ).map(([id, label]) => (
          <button key={id} className={screen === id ? "active" : ""} onClick={() => setScreen(id)}>
            <i aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
    </main>
  );
}

function MeasureScreen({
  distance,
  unit,
  measuring,
  engine,
  calibrated,
  onStart,
  onStop,
  onReset,
}: {
  distance: string;
  unit: Unit;
  measuring: boolean;
  engine: EngineSnapshot;
  calibrated: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}) {
  return (
    <div className="measure-screen">
      <div className="hero-readout">
        <p>Distance</p>
        <div className="number">{distance}<small>{unit === "in" ? "in" : "mm"}</small></div>
        {!calibrated && <p className="warning">Calibrate all four turns before relying on a measurement.</p>}
      </div>
      <div className="control-row">
        {!measuring ? <button className="button primary" onClick={onStart}>Start</button> : <button className="button danger" onClick={onStop}>Stop</button>}
        <button className="button" onClick={onReset}>Reset</button>
      </div>
      <div className="measurement-state">
        <div className="state-chip"><span className={`state-icon ${engine.state}`} /> {engine.state.replace("_", " ")}</div>
        <p>{engine.reason}</p>
      </div>
      <div className="metric-grid">
        <div className="metric-card"><span>Detected orientation</span><strong>{orientationLabels[engine.orientation]}</strong></div>
        <div className="metric-card"><span>Flip count</span><strong>{engine.accepted}</strong></div>
      </div>
      <div className="guardrails">
        <p>Acceptance gates</p>
        <span>Stable source</span><span>90° target</span><span>Settle time</span><span>No lift</span>
      </div>
    </div>
  );
}

function CalibrationScreen({
  unit,
  calibration,
  calStep,
  calMarker,
  rulerScale,
  ticks,
  onMarker,
  onScale,
  onSave,
  onRestart,
}: {
  unit: Unit;
  calibration: number[];
  calStep: number;
  calMarker: number;
  rulerScale: number;
  ticks: number[];
  onMarker: (value: number) => void;
  onScale: (value: number) => void;
  onSave: () => void;
  onRestart: () => void;
}) {
  const complete = calibration.every((value) => value > 0);
  return (
    <div className="calibration-screen">
      <div className="section-intro">
        <p className="eyebrow">CALIBRATION IS LOCAL</p>
        <h2>Make the phone its own measuring wheel.</h2>
        <p>First match the ruler to a real ruler. Then save one physical quarter-turn distance for each side.</p>
      </div>
      <section className="panel scale-panel">
        <div className="panel-heading"><div><span>1. Scale the on-screen ruler</span><strong>{round(rulerScale, 2)} px/mm</strong></div></div>
        <div className="scale-control">
          <button aria-label="Reduce ruler scale" onClick={() => onScale(Math.max(2.5, round(rulerScale - 0.02, 2)))}>−</button>
          <input aria-label="Ruler scale" type="range" min="2.5" max="5" step="0.01" value={rulerScale} onChange={(event) => onScale(Number(event.target.value))} />
          <button aria-label="Increase ruler scale" onClick={() => onScale(Math.min(5, round(rulerScale + 0.02, 2)))}>+</button>
        </div>
        <p className="hint">Lay a real ruler against the bottom scale. Adjust until its marks line up.</p>
      </section>
      <section className="panel turn-panel">
        <div className="turn-header"><span>2. Quarter-turn {Math.min(calStep + 1, 4)} of 4</span>{complete && <em>Complete</em>}</div>
        <h3>{complete ? "All four distances are saved" : "Place one side at zero. Roll exactly one quarter turn."}</h3>
        <p>{complete ? "Use Start over to replace any value." : "Move the marker until it matches where the phone stopped, then save this side."}</p>
        {!complete && <>
          <div className="marker-track">
            <div className="zero-line">0</div>
            <div className="marker-line" style={{ left: `${Math.min(94, Math.max(2, (calMarker / 160) * 100))}%` }} />
            <span className="marker-value" style={{ left: `${Math.min(91, Math.max(2, (calMarker / 160) * 100))}%` }}>{distanceLabel(calMarker, unit)}</span>
          </div>
          <input className="marker-slider" aria-label="Calibration marker distance" type="range" min="10" max="160" step="0.1" value={calMarker} onChange={(event) => onMarker(Number(event.target.value))} />
          <div className="turn-actions"><button className="button primary" onClick={onSave}>Save quarter turn {calStep + 1}</button><output>{distanceLabel(calMarker, unit)}</output></div>
        </>}
        {complete && <button className="button" onClick={onRestart}>Start over</button>}
      </section>
      <div className="saved-turns" aria-label="Saved calibration distances">
        {calibration.map((value, index) => <div key={index}><span>{index + 1}</span><strong>{value ? distanceLabel(value, unit) : "Not saved"}</strong></div>)}
      </div>
      <div className="ruler-shell" style={{ "--ruler-scale": rulerScale } as React.CSSProperties}>
        <div className="ruler" aria-label="Adjustable calibration ruler">
          {ticks.map((mm) => <div className={`ruler-tick ${mm % 25 === 0 ? "major" : mm % 10 === 0 ? "medium" : ""}`} key={mm} style={{ left: `calc(${mm} * var(--ruler-scale) * 1px)` }}><span>{mm % 25 === 0 ? `${(mm / 25.4).toFixed(mm === 0 ? 0 : 1)}″` : mm % 10 === 0 ? mm : ""}</span></div>)}
          <div className="ruler-unit">mm / in</div>
        </div>
      </div>
    </div>
  );
}

function DebugScreen({ reading, engine, measuring }: { reading: MotionReading; engine: EngineSnapshot; measuring: boolean }) {
  const rows = [
    ["Alpha", sensorValue(reading.alpha, 1)], ["Beta", sensorValue(reading.beta, 1)], ["Gamma", sensorValue(reading.gamma, 1)],
    ["Acceleration", `${sensorValue(reading.acceleration.x)}, ${sensorValue(reading.acceleration.y)}, ${sensorValue(reading.acceleration.z)}`],
    ["Acceleration incl. gravity", `${sensorValue(reading.gravity.x)}, ${sensorValue(reading.gravity.y)}, ${sensorValue(reading.gravity.z)}`],
    ["Rotation rate", `${sensorValue(reading.rotation.x)}, ${sensorValue(reading.rotation.y)}, ${sensorValue(reading.rotation.z)}`],
    ["Gravity magnitude", `${sensorValue(reading.gravityMagnitude)} m/s²`], ["Detected orientation", orientationLabels[reading.orientation]],
    ["Measurement state", measuring ? engine.state.replace("_", " ") : "stopped"], ["Accepted flips", String(engine.accepted)],
    ["Rejected flips", String(engine.rejected)], ["Reason", engine.reason],
  ];
  return <div className="debug-screen"><div className="section-intro"><p className="eyebrow">LIVE SENSOR TELEMETRY</p><h2>Tune the detector, not the UI.</h2><p>Values update from browser DeviceMotion and DeviceOrientation events. Units are degrees or m/s².</p></div><div className="debug-list">{rows.map(([label, value]) => <div className="debug-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><p className="debug-footnote">The detector accepts only a stable, orthogonal transition after it sees real motion. The rejection reason above is the last gate that failed.</p></div>;
}

function SettingsScreen({ settings, calibrationReady, confirmReset, onSettings, onReset, onCancel, onConfirm }: { settings: Settings; calibrationReady: boolean; confirmReset: boolean; onSettings: (settings: Settings) => void; onReset: () => void; onCancel: () => void; onConfirm: () => void }) {
  return <div className="settings-screen"><div className="section-intro"><p className="eyebrow">ON THIS DEVICE ONLY</p><h2>Settings</h2></div><section className="settings-group"><div className="settings-row"><div><span>Units</span><small>Output and calibration labels</small></div><div className="segmented"><button className={settings.unit === "in" ? "selected" : ""} onClick={() => onSettings({ ...settings, unit: "in" })}>Inches</button><button className={settings.unit === "mm" ? "selected" : ""} onClick={() => onSettings({ ...settings, unit: "mm" })}>mm</button></div></div><Toggle label="Sound" detail="Short tone for accepted flips" checked={settings.sound} onChange={(sound) => onSettings({ ...settings, sound })} /><Toggle label="Haptics" detail="Vibrate when supported" checked={settings.haptics} onChange={(haptics) => onSettings({ ...settings, haptics })} /></section><section className="settings-group danger-zone"><div><span>Calibration</span><small>{calibrationReady ? "Four quarter-turn values saved" : "Incomplete"}</small></div>{confirmReset ? <div className="reset-confirm"><p>Erase all four saved distances?</p><button className="button danger" onClick={onConfirm}>Erase calibration</button><button className="text-button" onClick={onCancel}>Cancel</button></div> : <button className="text-button destructive" onClick={onReset}>Reset calibration</button>}</section></div>;
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <div className="settings-row"><div><span>{label}</span><small>{detail}</small></div><button className={`toggle ${checked ? "on" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button></div>;
}
