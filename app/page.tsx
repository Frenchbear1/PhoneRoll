"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";

type Screen = "measure" | "calibration" | "settings" | "memory";
type Orientation = "face_up" | "face_down" | "top_edge" | "bottom_edge" | "left_edge" | "right_edge" | "unknown";
type TapeEdge = "bottom" | "right" | "top" | "left";
type EngineState = "idle" | "arming" | "ready" | "moving" | "cooldown";
type CalibrationPhase = "scale" | "start" | "rolling" | "complete";
type Vec = { x: number; y: number; z: number };
type MotionSample = { gravity: Vec; acceleration: Vec; rotation: Vec; orientation: Orientation; gravityMagnitude: number; at: number };
type ApplePermissionEvent = { requestPermission?: () => Promise<"granted" | "denied"> };
type QuarterTurn = { from: Orientation; to: Orientation };
type SavedCalibration = { values: number[]; orientationOrder: Orientation[]; zeroOffset: number | null };
type UserSettings = { units: "in" | "mm"; sound: boolean; haptics: boolean };
type PrecisionReading = { x: number; y: number; edge: TapeEdge; valueMm: number; label: string };
type MemoryEntry = { id: string; parts: string[]; savedAt: number };
type CalibrationRuntime = {
  lastAlignment: number;
  turnCount: number;
  draftValues: Array<number | null>;
  orientationOrder: Orientation[];
  pending: QuarterTurn | null;
  predictedMm: number | null;
  lastOrientation: Orientation;
};
type HomeRollRuntime = { orientation: Orientation; acceptedAt: number };

const STORE = {
  calibration: "phoneroll.tape-calibration.v3",
  legacyCalibration: "phoneroll.tape-calibration.v2",
  rulerScale: "phoneroll.ruler-scale.v1",
  settings: "phoneroll.settings.v1",
  memory: "phoneroll.measurement-memory.v1",
};
const TAPE_INCHES = 60;
const TAPE_TICKS = Array.from({ length: TAPE_INCHES * 16 + 1 }, (_, division) => ({
  division,
  inch: Math.floor(division / 16),
  fraction: division % 16,
}));
const METRIC_TICKS = Array.from({ length: 1501 }, (_, millimeter) => ({
  millimeter,
  centimeter: Math.floor(millimeter / 10),
  remainder: millimeter % 10,
}));
const DEFAULT_SETTINGS: UserSettings = { units: "in", sound: false, haptics: true };

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
const emptyRuntime = (): CalibrationRuntime => ({ lastAlignment: 0, turnCount: 0, draftValues: [null, null, null, null], orientationOrder: [], pending: null, predictedMm: null, lastOrientation: "unknown" });

const orientationFromGravity = (vector: Vec): Orientation => {
  const v = normalize(vector);
  const choices = [
    [Math.abs(v.x), v.x > 0 ? "right_edge" : "left_edge"],
    [Math.abs(v.y), v.y > 0 ? "top_edge" : "bottom_edge"],
    [Math.abs(v.z), v.z > 0 ? "face_up" : "face_down"],
  ] as const;
  const [largest, name] = choices.sort((a, b) => b[0] - a[0])[0];
  return largest > 0.8 ? name : "unknown";
};

const orientationName = (orientation: Orientation) => ({
  face_up: "face up",
  face_down: "face down",
  top_edge: "upside down",
  bottom_edge: "upright",
  left_edge: "left",
  right_edge: "right",
  unknown: "waiting for orientation",
}[orientation]);
const tapeEdgeForOrientation = (orientation: Orientation): TapeEdge => ({ bottom_edge: "bottom", right_edge: "right", top_edge: "top", left_edge: "left", face_up: "bottom", face_down: "top", unknown: "bottom" }[orientation]);
const DEFAULT_ROLL_ORDER: Orientation[] = ["bottom_edge", "right_edge", "top_edge", "left_edge"];
const orientationFromAngles = (beta: number | null, gamma: number | null): Orientation => {
  const b = safeNumber(beta);
  const g = safeNumber(gamma);
  if (Math.abs(g) > 52 && Math.abs(g) >= Math.abs(b) * 0.75) return g > 0 ? "right_edge" : "left_edge";
  if (Math.abs(b) > 52) return b > 0 ? "bottom_edge" : "top_edge";
  return "unknown";
};
const tapeSpanForEdge = (edge: TapeEdge) => {
  if (typeof window === "undefined") return edge === "left" || edge === "right" ? 844 : 390;
  return edge === "left" || edge === "right" ? window.innerHeight : window.innerWidth;
};
const savedRollOrder = (order: Orientation[]) => {
  const usable = order.length === 4 && order.every((orientation) => DEFAULT_ROLL_ORDER.includes(orientation));
  return usable ? order : DEFAULT_ROLL_ORDER;
};
const gcd = (a: number, b: number): number => b === 0 ? Math.abs(a) : gcd(b, a % b);
const formatInches = (value: number) => {
  const roundedSixteenths = Math.max(0, Math.round(value * 16));
  const whole = Math.floor(roundedSixteenths / 16);
  const fraction = roundedSixteenths % 16;
  if (!fraction) return `${whole} in`;
  const divisor = gcd(fraction, 16);
  const numerator = fraction / divisor;
  const denominator = 16 / divisor;
  return whole > 0 ? `${whole} ${numerator}/${denominator} in` : `${numerator}/${denominator} in`;
};
const formatMeasurement = (millimeters: number, units: UserSettings["units"]) => units === "mm"
  ? `${Math.max(0, Math.round(millimeters))} mm`
  : formatInches(millimeters / 25.4);

const loadJSON = <T,>(key: string, fallback: T): T => {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) as T : fallback;
  } catch {
    return fallback;
  }
};

const readSavedCalibration = (): SavedCalibration => {
  const saved = loadJSON<unknown>(STORE.calibration, null);
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    const value = saved as SavedCalibration;
    return {
      values: Array.isArray(value.values) && value.values.length === 4 ? value.values : [0, 0, 0, 0],
      orientationOrder: Array.isArray(value.orientationOrder) ? value.orientationOrder.slice(0, 4) : [],
      zeroOffset: Number.isFinite(value.zeroOffset) ? value.zeroOffset : null,
    };
  }
  const legacy = loadJSON<number[]>(STORE.legacyCalibration, [0, 0, 0, 0]);
  return { values: legacy.length === 4 ? legacy : [0, 0, 0, 0], orientationOrder: [], zeroOffset: null };
};

/** Accepts only a settled 90° roll and keeps opposite-direction movements out. */
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

  update(sample: MotionSample): QuarterTurn | null {
    if (this.state === "idle") return null;
    const acceleration = magnitude(sample.acceleration);
    const rotation = magnitude(sample.rotation);
    const gravityOK = sample.gravityMagnitude >= 7.2 && sample.gravityMagnitude <= 12.5;
    const stable = gravityOK && sample.orientation !== "unknown" && acceleration < 1.25 && rotation < 75;
    const unstableDuringRoll = (!gravityOK && sample.gravityMagnitude > 0.2) || acceleration > 5.7 || rotation > 620;
    if ((this.state === "moving" || this.state === "cooldown") && unstableDuringRoll) {
      this.rearm();
      return null;
    }
    const stableLongEnough = this.noteCandidate(sample, stable);
    if (this.state === "arming") {
      if (stableLongEnough && this.candidate) {
        this.source = { orientation: this.candidate.orientation, vector: this.candidate.vector };
        this.state = "ready";
      }
      return null;
    }
    if (this.state === "ready") {
      if (!stable || sample.orientation !== this.source?.orientation) {
        this.state = "moving";
        this.startedAt = sample.at;
        this.candidate = null;
      }
      return null;
    }
    if (this.state === "cooldown") {
      if (!stable) { this.rearm(); return null; }
      if (sample.at >= this.cooldownUntil && stableLongEnough && this.candidate) {
        this.source = { orientation: this.candidate.orientation, vector: this.candidate.vector };
        this.state = "ready";
      }
      return null;
    }
    if (this.state !== "moving" || !this.source) return null;
    const elapsed = sample.at - this.startedAt;
    if (elapsed > 2600 || !stableLongEnough || !this.candidate) {
      if (elapsed > 2600) this.rearm();
      return null;
    }
    const alignment = dot(this.source.vector, this.candidate.vector);
    if (this.candidate.orientation === this.source.orientation || alignment < -0.55 || Math.abs(alignment) > 0.38 || elapsed < 95) {
      this.rearm();
      return null;
    }
    const axis = normalize(cross(this.source.vector, this.candidate.vector));
    if (this.rollAxis && dot(axis, this.rollAxis) < 0.42) { this.rearm(); return null; }
    this.rollAxis ??= axis;
    this.accepted += 1;
    this.state = "cooldown";
    this.cooldownUntil = sample.at + 320;
    return { from: this.source.orientation, to: this.candidate.orientation };
  }
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("measure");
  const [rulerScale, setRulerScale] = useState(3.78);
  const [calibration, setCalibration] = useState<number[]>([0, 0, 0, 0]);
  const [calibrationOrder, setCalibrationOrder] = useState<Orientation[]>([]);
  const [zeroAlignment, setZeroAlignment] = useState<number | null>(null);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [tapeOffset, setTapeOffset] = useState(-2);
  const [reversed, setReversed] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [calibrationPhase, setCalibrationPhase] = useState<CalibrationPhase>("scale");
  const [detectedOrientation, setDetectedOrientation] = useState<Orientation>("unknown");
  const [calibrationTurns, setCalibrationTurns] = useState(0);
  const [predictedDistance, setPredictedDistance] = useState<number | null>(null);
  const [calibrationNotice, setCalibrationNotice] = useState("");
  const [motionNotice, setMotionNotice] = useState("");
  const [precisionReading, setPrecisionReading] = useState<PrecisionReading | null>(null);
  const [precisionFrozen, setPrecisionFrozen] = useState(false);
  const [draftMeasurements, setDraftMeasurements] = useState<string[]>([]);
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);

  const detector = useRef(new QuarterTurnEngine());
  const calibrationRef = useRef(calibration);
  const calibrationOrderRef = useRef(calibrationOrder);
  const zeroAlignmentRef = useRef(zeroAlignment);
  const rulerScaleRef = useRef(rulerScale);
  const tapeOffsetRef = useRef(tapeOffset);
  const reversedRef = useRef(reversed);
  const motionEnabledRef = useRef(motionEnabled);
  const screenRef = useRef(screen);
  const calibrationPhaseRef = useRef(calibrationPhase);
  const detectedOrientationRef = useRef(detectedOrientation);
  const orientationStableSince = useRef(0);
  const motionSampleAt = useRef(0);
  const homeRoll = useRef<HomeRollRuntime>({ orientation: "unknown", acceptedAt: 0 });
  const calibrationRuntime = useRef<CalibrationRuntime>(emptyRuntime());
  const settingsRef = useRef(settings);
  const precisionReadingRef = useRef<PrecisionReading | null>(null);
  const precisionFrozenRef = useRef(false);
  const audioContext = useRef<AudioContext | null>(null);

  useEffect(() => {
    const savedScale = Number(localStorage.getItem(STORE.rulerScale) ?? 3.78);
    const savedCalibration = readSavedCalibration();
    const savedSettings = loadJSON<UserSettings>(STORE.settings, DEFAULT_SETTINGS);
    const savedMemory = loadJSON<MemoryEntry[]>(STORE.memory, []);
    calibrationRef.current = savedCalibration.values;
    calibrationOrderRef.current = savedCalibration.orientationOrder;
    zeroAlignmentRef.current = savedCalibration.zeroOffset;
    setRulerScale(clamp(Number.isFinite(savedScale) ? savedScale : 3.78, 2.5, 10));
    setCalibration(savedCalibration.values);
    setCalibrationOrder(savedCalibration.orientationOrder);
    setZeroAlignment(savedCalibration.zeroOffset);
    setTapeOffset(savedCalibration.zeroOffset ?? -2);
    setSettings({
      units: savedSettings.units === "mm" ? "mm" : "in",
      sound: Boolean(savedSettings.sound),
      haptics: savedSettings.haptics !== false,
    });
    setMemoryEntries(Array.isArray(savedMemory) ? savedMemory.filter((entry) => entry && Array.isArray(entry.parts)) : []);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  useEffect(() => { calibrationRef.current = calibration; localStorage.setItem(STORE.calibration, JSON.stringify({ values: calibration, orientationOrder: calibrationOrderRef.current, zeroOffset: zeroAlignmentRef.current })); }, [calibration]);
  useEffect(() => { calibrationOrderRef.current = calibrationOrder; localStorage.setItem(STORE.calibration, JSON.stringify({ values: calibrationRef.current, orientationOrder: calibrationOrder, zeroOffset: zeroAlignmentRef.current })); }, [calibrationOrder]);
  useEffect(() => { zeroAlignmentRef.current = zeroAlignment; localStorage.setItem(STORE.calibration, JSON.stringify({ values: calibrationRef.current, orientationOrder: calibrationOrderRef.current, zeroOffset: zeroAlignment })); }, [zeroAlignment]);
  useEffect(() => { rulerScaleRef.current = rulerScale; localStorage.setItem(STORE.rulerScale, String(rulerScale)); }, [rulerScale]);
  useEffect(() => { tapeOffsetRef.current = tapeOffset; }, [tapeOffset]);
  useEffect(() => { reversedRef.current = reversed; }, [reversed]);
  useEffect(() => { motionEnabledRef.current = motionEnabled; }, [motionEnabled]);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { calibrationPhaseRef.current = calibrationPhase; }, [calibrationPhase]);
  useEffect(() => { detectedOrientationRef.current = detectedOrientation; }, [detectedOrientation]);
  useEffect(() => { settingsRef.current = settings; localStorage.setItem(STORE.settings, JSON.stringify(settings)); }, [settings]);
  useEffect(() => { precisionReadingRef.current = precisionReading; }, [precisionReading]);
  useEffect(() => { precisionFrozenRef.current = precisionFrozen; }, [precisionFrozen]);
  useEffect(() => { localStorage.setItem(STORE.memory, JSON.stringify(memoryEntries)); }, [memoryEntries]);

  const confirmFlip = () => {
    const feedback = settingsRef.current;
    if (feedback.haptics && typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(16);
    if (!feedback.sound || !audioContext.current) return;
    try {
      const context = audioContext.current;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.055, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.07);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.075);
    } catch {
      // Feedback is optional and should never interrupt measuring.
    }
  };

  const advanceHomeTape = (nextOrientation: Orientation, at: number) => {
    if (screenRef.current !== "measure" || !motionEnabledRef.current || nextOrientation === "unknown") return;
    const saved = calibrationRef.current;
    if (saved.some((value) => value <= 0)) {
      homeRoll.current.orientation = nextOrientation;
      return;
    }
    const order = savedRollOrder(calibrationOrderRef.current);
    const previous = homeRoll.current.orientation;
    if (previous === "unknown" || previous === nextOrientation) {
      homeRoll.current.orientation = nextOrientation;
      return;
    }
    const fromIndex = order.indexOf(previous);
    const toIndex = order.indexOf(nextOrientation);
    if (fromIndex < 0 || toIndex < 0) {
      homeRoll.current.orientation = nextOrientation;
      return;
    }
    const forward = toIndex === (fromIndex + 1) % 4;
    const backward = toIndex === (fromIndex + 3) % 4;
    const expectedDirection = reversedRef.current ? backward : forward;
    if (!expectedDirection || at - homeRoll.current.acceptedAt < 280) {
      homeRoll.current.orientation = nextOrientation;
      return;
    }
    const distanceMm = forward ? saved[fromIndex] : saved[toIndex];
    setTapeOffset((current) => current + (reversedRef.current ? distanceMm : -distanceMm) * rulerScaleRef.current);
    homeRoll.current = { orientation: nextOrientation, acceptedAt: at };
    confirmFlip();
  };

  useEffect(() => {
    const updateDetectedOrientation = (nextOrientation: Orientation, at: number) => {
      if (nextOrientation === "unknown" || detectedOrientationRef.current === nextOrientation) return;
      advanceHomeTape(nextOrientation, at);
      detectedOrientationRef.current = nextOrientation;
      orientationStableSince.current = at;
      setDetectedOrientation(nextOrientation);
    };
    const readMotion = (event: DeviceMotionEvent) => {
      const gravity = event.accelerationIncludingGravity ? { x: safeNumber(event.accelerationIncludingGravity.x), y: safeNumber(event.accelerationIncludingGravity.y), z: safeNumber(event.accelerationIncludingGravity.z) } : blank();
      const acceleration = event.acceleration ? { x: safeNumber(event.acceleration.x), y: safeNumber(event.acceleration.y), z: safeNumber(event.acceleration.z) } : blank();
      const rotation = event.rotationRate ? { x: safeNumber(event.rotationRate.alpha), y: safeNumber(event.rotationRate.beta), z: safeNumber(event.rotationRate.gamma) } : blank();
      const sample: MotionSample = { gravity, acceleration, rotation, orientation: orientationFromGravity(gravity), gravityMagnitude: magnitude(gravity), at: event.timeStamp || performance.now() };
      motionSampleAt.current = sample.at;
      updateDetectedOrientation(sample.orientation, sample.at);
      if (!motionEnabledRef.current || (screenRef.current === "calibration" && calibrationPhaseRef.current === "rolling")) return;
      detector.current.update(sample);
    };
    const readOrientation = (event: DeviceOrientationEvent) => {
      const now = event.timeStamp || performance.now();
      if (now - motionSampleAt.current < 350) return;
      updateDetectedOrientation(orientationFromAngles(event.beta, event.gamma), now);
    };
    window.addEventListener("devicemotion", readMotion, true);
    window.addEventListener("deviceorientation", readOrientation, true);
    return () => {
      window.removeEventListener("devicemotion", readMotion, true);
      window.removeEventListener("deviceorientation", readOrientation, true);
    };
  }, []);

  const enableMotion = async () => {
    const primeSound = () => {
      if (!settingsRef.current.sound || typeof window === "undefined") return;
      const AudioConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioConstructor) return;
      audioContext.current ??= new AudioConstructor();
      void audioContext.current.resume();
    };
    if (motionEnabledRef.current) {
      primeSound();
      setMotionNotice(calibrationRef.current.some((value) => value <= 0) ? "Motion is on. Calibrate the tape before it can measure." : "Rolling is on.");
      return true;
    }
    try {
      const motion = DeviceMotionEvent as unknown as ApplePermissionEvent;
      const orientation = DeviceOrientationEvent as unknown as ApplePermissionEvent;
      const requested = [motion, orientation].filter((event) => typeof event.requestPermission === "function");
      if (requested.length) {
        const decisions = await Promise.all(requested.map((event) => event.requestPermission?.()));
        if (decisions.some((decision) => decision !== "granted")) {
          setMotionNotice("Motion permission was not enabled. Tap again and allow it.");
          return false;
        }
      }
      detector.current.reset();
      homeRoll.current = { orientation: detectedOrientationRef.current, acceptedAt: performance.now() };
      motionEnabledRef.current = true;
      setMotionEnabled(true);
      primeSound();
      setMotionNotice(calibrationRef.current.some((value) => value <= 0) ? "Motion is on. Calibrate the tape before it can measure." : "Rolling is on.");
      return true;
    } catch {
      setMotionNotice("Motion could not be enabled in this browser.");
      return false;
    }
  };

  const clearPrecisionReading = () => {
    precisionReadingRef.current = null;
    precisionFrozenRef.current = false;
    setPrecisionReading(null);
    setPrecisionFrozen(false);
    setDraftMeasurements([]);
  };
  const readingCoordinate = (clientX: number, clientY: number, edge: TapeEdge) => {
    const span = tapeSpanForEdge(edge);
    if (edge === "top") return span - clientX;
    if (edge === "right") return span - clientY;
    if (edge === "left") return clientY;
    return clientX;
  };
  const capturePrecisionReading = (clientX: number, clientY: number) => {
    if (precisionFrozenRef.current) return;
    const edge = tapeEdgeForOrientation(detectedOrientationRef.current);
    const direction = reversedRef.current ? -1 : 1;
    const coordinate = readingCoordinate(clientX, clientY, edge);
    const valueMm = Math.max(0, ((coordinate - tapeOffsetRef.current) / direction) / rulerScaleRef.current);
    const reading = { x: clientX, y: clientY, edge, valueMm, label: formatMeasurement(valueMm, settingsRef.current.units) };
    precisionReadingRef.current = reading;
    setPrecisionReading(reading);
  };
  const freezePrecisionReading = () => {
    if (!precisionReadingRef.current) return;
    precisionFrozenRef.current = true;
    setPrecisionFrozen(true);
  };
  const saveMemoryReading = () => {
    const parts = precisionReadingRef.current ? [...draftMeasurements, precisionReadingRef.current.label] : draftMeasurements;
    if (!parts.length) return;
    setMemoryEntries((current) => [{ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, parts, savedAt: Date.now() }, ...current]);
    clearPrecisionReading();
  };
  const addMemoryPart = () => {
    const reading = precisionReadingRef.current;
    if (!reading) return;
    setDraftMeasurements((current) => [...current, reading.label]);
    precisionReadingRef.current = null;
    precisionFrozenRef.current = false;
    setPrecisionReading(null);
    setPrecisionFrozen(false);
  };

  const resetTapeZero = () => {
    const startingEdge = zeroAlignmentRef.current ?? -2;
    const edge = tapeEdgeForOrientation(detectedOrientationRef.current);
    const tapeSpan = tapeSpanForEdge(edge);
    homeRoll.current = { orientation: detectedOrientationRef.current, acceptedAt: performance.now() };
    setTapeOffset(reversedRef.current ? tapeSpan - startingEdge : startingEdge);
    clearPrecisionReading();
  };
  useEffect(() => {
    const zeroOnHome = () => {
      if (screenRef.current === "measure") resetTapeZero();
    };
    zeroOnHome();
    window.addEventListener("pageshow", zeroOnHome);
    document.addEventListener("visibilitychange", zeroOnHome);
    return () => {
      window.removeEventListener("pageshow", zeroOnHome);
      document.removeEventListener("visibilitychange", zeroOnHome);
    };
  }, [zeroAlignment, reversed]);
  const chooseDirection = (nextReversed: boolean) => {
    setReversed(nextReversed);
    reversedRef.current = nextReversed;
    resetTapeZero();
    if (motionEnabledRef.current) detector.current.reset();
  };
  const openCalibration = () => {
    detector.current.stop();
    homeRoll.current = { orientation: "unknown", acceptedAt: 0 };
    motionEnabledRef.current = false;
    setMotionEnabled(false);
    setCalibrationPhase("scale");
    setCalibrationTurns(0);
    setPredictedDistance(null);
    calibrationRuntime.current = emptyRuntime();
    setCalibrationNotice("");
    setMotionNotice("");
    setScreen("calibration");
  };
  const openSettings = () => {
    detector.current.stop();
    homeRoll.current = { orientation: "unknown", acceptedAt: 0 };
    motionEnabledRef.current = false;
    setMotionEnabled(false);
    setScreen("settings");
  };
  const openMemory = () => {
    detector.current.stop();
    homeRoll.current = { orientation: "unknown", acceptedAt: 0 };
    motionEnabledRef.current = false;
    setMotionEnabled(false);
    setScreen("memory");
  };
  const goToMeasure = () => {
    resetTapeZero();
    setScreen("measure");
  };
  const saveScale = async () => {
    const enabled = await enableMotion();
    if (!enabled) {
      setCalibrationNotice("Allow Motion & Orientation so PhoneRoll can remember each rolling position.");
      return;
    }
    detector.current.stop();
    setCalibrationNotice("");
    setCalibrationPhase("start");
  };
  const captureStart = () => {
    const startOrientation = detectedOrientationRef.current;
    if (startOrientation === "unknown") {
      setCalibrationNotice("Hold the phone upright and still until its orientation appears below.");
      return;
    }
    calibrationRuntime.current = { ...emptyRuntime(), lastAlignment: tapeOffset, orientationOrder: [startOrientation], lastOrientation: startOrientation };
    zeroAlignmentRef.current = tapeOffset;
    setZeroAlignment(tapeOffset);
    setCalibrationTurns(0);
    setPredictedDistance(null);
    setCalibrationNotice("");
    setCalibrationPhase("rolling");
    detector.current.stop();
  };
  const saveAlignment = () => {
    const runtime = calibrationRuntime.current;
    const nextOrientation = detectedOrientationRef.current;
    if (nextOrientation === "unknown") {
      setCalibrationNotice("Hold the phone still until PhoneRoll can identify the new edge.");
      return;
    }
    if (nextOrientation === runtime.lastOrientation) {
      setCalibrationNotice("Rotate one quarter turn first. The detected edge has not changed yet.");
      return;
    }
    if (performance.now() - orientationStableSince.current < 240) {
      setCalibrationNotice("Hold this edge still for a moment, then save the alignment.");
      return;
    }
    const distanceMm = Math.abs(tapeOffset - runtime.lastAlignment) / rulerScale;
    if (distanceMm < 3) {
      setCalibrationNotice("Drag the tape to the new matching mark before saving this alignment.");
      return;
    }
    const index = runtime.turnCount % 4;
    runtime.draftValues[index] = distanceMm;
    runtime.lastAlignment = tapeOffset;
    runtime.lastOrientation = nextOrientation;
    runtime.orientationOrder[(index + 1) % 4] = nextOrientation;
    runtime.turnCount += 1;
    setPredictedDistance(null);
    setCalibrationTurns(runtime.turnCount);
    if (runtime.turnCount < 4) {
      setCalibrationNotice("");
      return;
    }
    const values = runtime.draftValues.map((value) => value ?? 0);
    if (values.some((value) => value <= 3) || runtime.orientationOrder.length !== 4) {
      setCalibrationNotice("One of the four sides is still missing. Rotate once more and save it.");
      return;
    }
    setCalibration(values);
    setCalibrationOrder(runtime.orientationOrder);
    setCalibrationNotice("");
    setCalibrationPhase("complete");
    detector.current.stop();
  };
  const resetCalibration = () => {
    setCalibration([0, 0, 0, 0]);
    setCalibrationOrder([]);
    setZeroAlignment(null);
    setCalibrationPhase("scale");
    setCalibrationTurns(0);
    setPredictedDistance(null);
    calibrationRuntime.current = emptyRuntime();
    setCalibrationNotice("");
  };
  const sharedTape = (draggable: boolean, edge: TapeEdge = "bottom", showControls = screen === "measure", tapeReversed = reversed) => <TapeRuler
    offset={tapeOffset}
    scaleMm={rulerScale}
    units={settings.units}
    edge={edge}
    reversed={tapeReversed}
    draggable={draggable}
    showControls={showControls}
    showEnableHint={false}
    motionNotice=""
    onOffset={setTapeOffset}
    onDirection={chooseDirection}
    onReset={resetTapeZero}
    onEnableMotion={screen === "measure" ? enableMotion : () => undefined}
  />;

  const measureEdge = tapeEdgeForOrientation(detectedOrientation);

  return <main className="app-shell" onPointerDownCapture={() => { void enableMotion(); }}>
    {screen === "measure" && <MeasureScreen calibrated={calibration.every((value) => value > 0)} edge={measureEdge} motionEnabled={motionEnabled} motionNotice={motionNotice} precisionReading={precisionReading} draftMeasurements={draftMeasurements} onPrecisionPoint={capturePrecisionReading} onPrecisionFreeze={freezePrecisionReading} onSaveMeasurement={saveMemoryReading} onAddMeasurementPart={addMemoryPart} onEnableMotion={enableMotion} onCalibrate={openCalibration} onMemory={openMemory} onSettings={openSettings}>{sharedTape(false, measureEdge)}</MeasureScreen>}
    {screen === "calibration" && <CalibrationScreen phase={calibrationPhase} detectedOrientation={detectedOrientation} turns={calibrationTurns} notice={calibrationNotice} rulerScale={rulerScale} onScale={(value) => setRulerScale(clamp(value, 2.5, 10))} onSaveScale={saveScale} onCaptureStart={captureStart} onSaveAlignment={saveAlignment} onBack={goToMeasure} onFinish={goToMeasure}>{sharedTape(true, calibrationPhase === "rolling" ? tapeEdgeForOrientation(detectedOrientation) : "bottom", false, false)}</CalibrationScreen>}
    {screen === "settings" && <SettingsScreen calibrated={calibration.every((value) => value > 0)} settings={settings} onChangeSettings={setSettings} onReset={resetCalibration} onBack={goToMeasure} />}
    {screen === "memory" && <MemoryScreen entries={memoryEntries} onDelete={(ids) => setMemoryEntries((current) => current.filter((entry) => !ids.includes(entry.id)))} onBack={goToMeasure} />}
  </main>;
}

function MeasureScreen({ calibrated, edge, motionEnabled, motionNotice, precisionReading, draftMeasurements, onPrecisionPoint, onPrecisionFreeze, onSaveMeasurement, onAddMeasurementPart, onEnableMotion, onCalibrate, onMemory, onSettings, children }: {
  calibrated: boolean;
  edge: TapeEdge;
  motionEnabled: boolean;
  motionNotice: string;
  precisionReading: PrecisionReading | null;
  draftMeasurements: string[];
  onPrecisionPoint: (clientX: number, clientY: number) => void;
  onPrecisionFreeze: () => void;
  onSaveMeasurement: () => void;
  onAddMeasurementPart: () => void;
  onEnableMotion: () => Promise<boolean>;
  onCalibrate: () => void;
  onMemory: () => void;
  onSettings: () => void;
  children: ReactNode;
}) {
  const hold = useRef<number | null>(null);
  const canMeasureFrom = (target: EventTarget | null) => target instanceof HTMLElement && !target.closest("button");
  const startPreciseRead = (event: ReactPointerEvent<HTMLElement>) => {
    if (!canMeasureFrom(event.target)) return;
    hold.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    onPrecisionPoint(event.clientX, event.clientY);
  };
  const movePreciseRead = (event: ReactPointerEvent<HTMLElement>) => {
    if (hold.current !== event.pointerId) return;
    onPrecisionPoint(event.clientX, event.clientY);
  };
  const endPreciseRead = (event: ReactPointerEvent<HTMLElement>) => {
    if (hold.current !== event.pointerId) return;
    hold.current = null;
    onPrecisionFreeze();
  };
  const pending = draftMeasurements.length ? draftMeasurements.join(" x ") : "";
  const lineStyle = precisionReading ? (precisionReading.edge === "left" || precisionReading.edge === "right"
    ? { top: precisionReading.y } as CSSProperties
    : { left: precisionReading.x } as CSSProperties) : undefined;
  return <section className={`measure-screen measure-orientation-${edge}`} onPointerDown={startPreciseRead} onPointerMove={movePreciseRead} onPointerUp={endPreciseRead} onPointerCancel={endPreciseRead}>
    <div className="measure-stage">
      <div className="home-status-cluster">
        <span className={`measure-status ${calibrated ? "ready" : "calibrate"}`}>{calibrated ? "Calibrated" : "Calibrate"}{calibrated && motionEnabled && <span className="status-dot"> · </span>} {calibrated && motionEnabled && <span className="rolling-inline">Rolling live</span>}</span>
        <span className="orientation-reminder">Lock phone orientation first</span>
        {calibrated && !motionEnabled && <button className="enable-motion-button" onClick={() => void onEnableMotion()}>Enable rolling</button>}
        {motionNotice && !motionEnabled && <span className="rolling-warning">{motionNotice}</span>}
      </div>
      <div className="home-actions" aria-label="PhoneRoll controls">
        <button className="home-icon-button calibrate-icon" aria-label="Calibrate tape" title="Calibrate tape" onClick={onCalibrate} />
        <button className="home-icon-button memory-icon" aria-label="Measurement memory" title="Measurement memory" onClick={onMemory} />
        <button className="home-icon-button settings-icon" aria-label="Settings" title="Settings" onClick={onSettings}>⚙</button>
      </div>
    </div>
    {precisionReading && <div className={`precision-line precision-line-${precisionReading.edge}`} style={lineStyle} aria-hidden="true" />}
    {precisionReading && <div className="precision-readout" role="status" aria-live="polite">
      {pending && <span className="precision-pending">{pending} x</span>}
      <strong><MeasurementText label={precisionReading.label} /></strong>
      <div className="precision-actions">
        <button onClick={onAddMeasurementPart}>By</button>
        <button onClick={onSaveMeasurement}>Save</button>
      </div>
    </div>}
    {children}
  </section>;
}

function LegacyCalibrationScreen({ phase, detectedOrientation, turns, notice, rulerScale, reversed, onScale, onSaveScale, onCaptureStart, onSaveAlignment, onBack, onFinish, children }: {
  phase: CalibrationPhase; detectedOrientation: Orientation; turns: number; notice: string; rulerScale: number; reversed: boolean; onScale: (value: number) => void; onSaveScale: () => void; onCaptureStart: () => void; onSaveAlignment: () => void; onBack: () => void; onFinish: () => void; children: ReactNode;
}) {
  const status = phase === "rolling"
    ? <div className="calibration-status"><span>Detected edge</span><strong>{orientationName(detectedOrientation)}</strong><span>Saved sides</span><strong>{turns} of 4</strong></div>
    : null;
  const readyForFinish = false;
  const onConfirmPrediction = () => undefined;
  let steps = {
    scale: <><p className="step-count">Step 1 of 3</p><h1>Match the tape to a real tape measure.</h1><p>Adjust the scale until the inch and fraction marks on the yellow tape line up with your real tape. The slider only changes its physical size.</p><input className="scale-slider" aria-label="Tape scale" type="range" min="2.5" max="10" step="0.01" value={rulerScale} onChange={(event) => onScale(Number(event.target.value))} /><button className="action-button" onClick={onSaveScale}>Save tape size</button></>,
    start: <><p className="step-count">Step 2 of 3</p><h1>Start upright with the left side at zero.</h1><p>Stand the phone upright on the real tape measure with its left side at the 0 mark. Drag the yellow tape so the same mark lines up, then lock this first orientation.</p><div className="orientation-readout"><span>Detected orientation</span><strong>{orientationName(detectedOrientation)}</strong></div><button className="action-button" onClick={onCaptureStart}>Lock starting alignment</button></>,
    rolling: <><p className="step-count">Step 3 of 3 · roll, align, repeat</p><h1>{readyForFinish ? "Was the prediction right?" : "Roll once, then align the tape."}</h1><p>{readyForFinish ? "If the yellow tape is already on the right mark, finish calibration. Otherwise nudge it, save the corrected alignment, and keep rolling." : `Roll one quarter turn ${reversed ? "to the left" : "to the right"}. Drag the yellow tape to the real tape’s matching mark. After two saved rolls, PhoneRoll will predict the next one.`}</p>{status}</>,
    complete: <><p className="step-count">Calibration complete</p><h1>The tape is ready to roll.</h1><p>PhoneRoll saved four orientation-aware rolling distances. Back on the ruler, use the left or right arrow to choose direction, or reset it to zero before measuring.</p><button className="action-button" onClick={onFinish}>Use the tape</button></>,
  };
  steps = { ...steps, rolling: <><p className="step-count">Step 3 of 3 · side {Math.min(turns + 1, 4)} of 4</p><h1>Rotate once, align, then save.</h1><p>Roll one quarter turn {reversed ? "to the left" : "to the right"}. PhoneRoll follows the detected edge, including the upside-down side. Align the tape to the real ruler, then save this side.</p>{status}</> };
  return <section className="calibration-screen"><header className="page-header"><button onClick={onBack}>‹ Ruler</button><span>Calibration</span></header><div className="calibration-card">{steps[phase]}{notice && <p className="calibration-notice">{notice}</p>}</div>{phase === "rolling" && <div className="calibration-float"><div className="corner-progress continuous-progress" aria-label="Calibration roll progress">{Array.from({ length: 4 }, (_, index) => <span className={index < Math.min(turns, 4) ? "saved" : index === turns % 4 ? "active" : ""} key={index}>{index + 1}</span>)}</div><div className="alignment-actions"><button className="plain-button" onClick={onSaveAlignment}>Save alignment &amp; roll again</button>{readyForFinish && <button className="action-button" onClick={onConfirmPrediction}>Looks right — finish</button>}</div></div>}{children}</section>;
}

function CalibrationScreen({ phase, detectedOrientation, turns, notice, rulerScale, onScale, onSaveScale, onCaptureStart, onSaveAlignment, onBack, onFinish, children }: {
  phase: CalibrationPhase; detectedOrientation: Orientation; turns: number; notice: string; rulerScale: number; onScale: (value: number) => void; onSaveScale: () => void; onCaptureStart: () => void; onSaveAlignment: () => void; onBack: () => void; onFinish: () => void; children: ReactNode;
}) {
  const edge = tapeEdgeForOrientation(detectedOrientation);
  const rolling = phase === "rolling";
  const intro = {
    scale: <><p className="orientation-reminder inline">Lock phone orientation before calibration.</p><p className="step-count">Step 1 of 3</p><h1>Match the tape to a real tape measure.</h1><p>Adjust the scale until the inch and fraction marks line up with your real tape.</p><input className="scale-slider" aria-label="Tape scale" type="range" min="2.5" max="10" step="0.01" value={rulerScale} onChange={(event) => onScale(Number(event.target.value))} /><button className="action-button" onClick={onSaveScale}>Save tape size</button></>,
    start: <><p className="orientation-reminder inline">Keep phone orientation lock on.</p><p className="step-count">Step 2 of 3</p><h1>Start upright with the left side at zero.</h1><p>Keep the phone upright. Align its left edge at 0 on the real ruler, align the yellow tape, then lock this starting position.</p><div className="orientation-readout"><span>Detected orientation</span><strong>{orientationName(detectedOrientation)}</strong></div><button className="action-button" onClick={onCaptureStart}>Lock starting alignment</button></>,
    rolling: <><p className="orientation-reminder inline">Keep phone orientation lock on.</p><p className="step-count">Step 3 of 3 · side {Math.min(turns + 1, 4)} of 4</p><h1>Rotate, align, save.</h1><p>Rotate one quarter turn to the right. The complete calibration view turns with the detected phone edge.</p><div className="calibration-status"><span>Detected edge</span><strong>{orientationName(detectedOrientation)}</strong><span>Saved sides</span><strong>{turns} of 4</strong></div></>,
    complete: <><p className="step-count">Calibration complete</p><h1>The tape is ready to roll.</h1><p>All four orientation-aware side distances are saved.</p><button className="action-button" onClick={onFinish}>Use the tape</button></>,
  };
  return <section className={`calibration-screen calibration-orientation-${rolling ? edge : "bottom"}`}><div className="calibration-stage"><header className="page-header"><button onClick={onBack}>‹ Ruler</button><span>Calibration</span></header><div className="calibration-card">{intro[phase]}{notice && <p className="calibration-notice">{notice}</p>}</div>{rolling && <div className="calibration-float"><div className="alignment-actions"><button className="plain-button" onClick={onSaveAlignment}>Save alignment</button></div><div className="corner-progress continuous-progress" aria-label="Four-side calibration progress">{Array.from({ length: 4 }, (_, index) => <span className={index < turns ? "saved" : index === turns ? "active" : ""} key={index}>{index + 1}</span>)}</div></div>}</div>{children}</section>;
}

function MemoryScreen({ entries, onDelete, onBack }: { entries: MemoryEntry[]; onDelete: (ids: string[]) => void; onBack: () => void }) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const allSelected = entries.length > 0 && selectedIds.length === entries.length;
  const leaveSelection = () => {
    setSelecting(false);
    setSelectedIds([]);
  };
  const toggleEntry = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((savedId) => savedId !== id) : [...current, id]);
  const selectAll = () => setSelectedIds(allSelected ? [] : entries.map((entry) => entry.id));
  const deleteSelected = () => {
    if (!selectedIds.length) return;
    onDelete(selectedIds);
    leaveSelection();
  };
  return <section className="memory-screen">
    <header className={`page-header memory-header ${selecting ? "selecting" : ""}`}>
      <button onClick={selecting ? leaveSelection : onBack}>{selecting ? "‹ Back" : "‹ Ruler"}</button>
      <span>Memory</span>
      {selecting ? <button className="delete-memory-button" disabled={!selectedIds.length} onClick={deleteSelected}>Delete</button> : <span />}
    </header>
    <div className="memory-card">
      <div className="memory-title-row">
        {selecting ? <button className="memory-title-back" onClick={leaveSelection}>‹ Back</button> : <h1>Saved measurements</h1>}
        {entries.length > 0 && <button className="memory-select-button" onClick={selecting ? selectAll : () => setSelecting(true)}>{selecting ? (allSelected ? "Clear all" : "Select all") : "Select"}</button>}
      </div>
      {entries.length === 0 ? <p className="empty-memory">Hold on the ruler, then save a reading here.</p> : <div className={`memory-list ${selecting ? "is-selecting" : ""}`}>{entries.map((entry) => {
        const selected = selectedIds.includes(entry.id);
        return <button className={`memory-row ${selected ? "selected" : ""}`} key={entry.id} onClick={() => selecting && toggleEntry(entry.id)} disabled={!selecting}>
          {selecting && <span className="memory-check" aria-hidden="true">{selected ? "✓" : ""}</span>}
          <strong>{entry.parts.map((part, index) => <span className="memory-part" key={`${entry.id}-${index}`}><MeasurementText label={part} compact />{index < entry.parts.length - 1 && <em>x</em>}</span>)}</strong>
          <span>{new Date(entry.savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        </button>;
      })}</div>}
    </div>
  </section>;
}

function MeasurementText({ label, compact = false }: { label: string; compact?: boolean }) {
  const inchMatch = label.match(/^(\d+)?(?:\s+)?(?:(\d+)\/(\d+))?\s+in$/);
  if (!inchMatch) return <span className={`measurement-text ${compact ? "compact" : ""}`}>{label}</span>;
  const [, whole, numerator, denominator] = inchMatch;
  return <span className={`measurement-text inch-format ${compact ? "compact" : ""}`}>
    {whole && <span className="whole-number">{whole}</span>}
    {numerator && denominator && <span className="stacked-fraction"><span>{numerator}</span><span>{denominator}</span></span>}
    <span className="unit-label">in</span>
  </span>;
}

function SettingsScreen({ calibrated, settings, onChangeSettings, onReset, onBack }: { calibrated: boolean; settings: UserSettings; onChangeSettings: (settings: UserSettings) => void; onReset: () => void; onBack: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const hapticsSupported = typeof navigator !== "undefined" && "vibrate" in navigator;
  const setSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => onChangeSettings({ ...settings, [key]: value });
  return <section className="settings-screen"><header className="page-header"><button onClick={onBack}>‹ Ruler</button><span>Settings</span></header><div className="settings-card"><h1>Ruler settings</h1><div className="settings-group"><div className="setting-row"><div><strong>Ruler labels</strong><span>Choose inches or millimeters</span></div><div className="segmented-control"><button className={settings.units === "in" ? "selected" : ""} onClick={() => setSetting("units", "in")}>in</button><button className={settings.units === "mm" ? "selected" : ""} onClick={() => setSetting("units", "mm")}>mm</button></div></div><ToggleRow label="Roll sound" detail="A quiet click for accepted rolls" checked={settings.sound} onChange={(checked) => setSetting("sound", checked)} /><ToggleRow label="Haptic feedback" detail={hapticsSupported ? "A small pulse for accepted rolls" : "Not supported by this browser"} checked={settings.haptics} disabled={!hapticsSupported} onChange={(checked) => setSetting("haptics", checked)} /></div><div className="settings-group calibration-settings"><strong>Tape calibration</strong><p>{calibrated ? "Four orientation-aware rolling distances are saved on this device." : "No complete tape calibration is saved yet."}</p>{confirming ? <div className="reset-row"><button className="action-button danger" onClick={() => { onReset(); setConfirming(false); }}>Reset calibration</button><button className="plain-button" onClick={() => setConfirming(false)}>Cancel</button></div> : <button className="plain-button danger-text" onClick={() => setConfirming(true)}>Reset calibration</button>}</div></div></section>;
}

function ToggleRow({ label, detail, checked, disabled = false, onChange }: { label: string; detail: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <div className={`setting-row ${disabled ? "disabled" : ""}`}><div><strong>{label}</strong><span>{detail}</span></div><button className={`switch ${checked ? "on" : ""}`} aria-label={label} aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></div>;
}

function TapeRuler({ offset, scaleMm, units, edge, reversed, draggable, showControls, showEnableHint, motionNotice, onOffset, onDirection, onReset, onEnableMotion }: { offset: number; scaleMm: number; units: "in" | "mm"; edge: TapeEdge; reversed: boolean; draggable: boolean; showControls: boolean; showEnableHint: boolean; motionNotice: string; onOffset: (value: number) => void; onDirection: (reversed: boolean) => void; onReset: () => void; onEnableMotion: () => void | Promise<boolean> }) {
  const drag = useRef<{ pointerId: number; startCoordinate: number; startOffset: number; edge: TapeEdge } | null>(null);
  const pixelsPerUnit = units === "in" ? scaleMm * 25.4 : scaleMm;
  const direction = reversed ? -1 : 1;
  const dragCoordinate = (event: ReactPointerEvent<HTMLDivElement>, tapeEdge: TapeEdge) => {
    if (tapeEdge === "top") return -event.clientX;
    if (tapeEdge === "right") return -event.clientY;
    if (tapeEdge === "left") return event.clientY;
    return event.clientX;
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    void onEnableMotion();
    if (!draggable) return;
    drag.current = { pointerId: event.pointerId, startCoordinate: dragCoordinate(event, edge), startOffset: offset, edge };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    onOffset(drag.current.startOffset + dragCoordinate(event, drag.current.edge) - drag.current.startCoordinate);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };
  const readiness = motionNotice;
  return <aside className={`tape-ruler edge-${edge} ${showEnableHint ? "is-inactive" : ""}`} aria-label="Construction tape ruler">
    {showControls && <div className="tape-controls" aria-label="Ruler direction and zero controls"><button className={!reversed ? "selected" : ""} aria-label="Measure right" onClick={() => onDirection(false)}>→</button><button className="zero-button" onClick={onReset}>0</button><button className={reversed ? "selected" : ""} aria-label="Measure left" onClick={() => onDirection(true)}>←</button></div>}
    <div className={`tape-viewport ${draggable ? "is-draggable" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {showEnableHint && <button className="motion-hint" onClick={() => void onEnableMotion()}>Tap to enable rolling</button>}
      {readiness && <span className="motion-status">{readiness}</span>}
      {units === "in"
        ? TAPE_TICKS.map(({ division, inch, fraction }) => <TapeTick key={division} x={offset + direction * (division / 16) * pixelsPerUnit} inch={inch} fraction={fraction} />)
        : METRIC_TICKS.map(({ millimeter, centimeter, remainder }) => <MetricTick key={millimeter} x={offset + direction * millimeter * pixelsPerUnit} centimeter={centimeter} remainder={remainder} />)}
    </div>
  </aside>;
}

function TapeTick({ x, inch, fraction }: { x: number; inch: number; fraction: number }) {
  const kind = fraction === 0 ? "inch" : fraction % 8 === 0 ? "half" : fraction % 4 === 0 ? "quarter" : fraction % 2 === 0 ? "eighth" : "sixteenth";
  const fractionText: Record<number, string> = { 0: String(inch), 4: "¼", 8: "½", 12: "¾" };
  return <div className={`tape-tick ${kind} ${inch === 0 && fraction === 0 ? "zero-tick" : ""}`} style={{ left: x } as CSSProperties}><span>{fractionText[fraction] ?? ""}</span></div>;
}

function MetricTick({ x, centimeter, remainder }: { x: number; centimeter: number; remainder: number }) {
  const kind = remainder === 0 ? "centimeter" : remainder === 5 ? "five-millimeter" : "millimeter";
  return <div className={`tape-tick metric ${kind}`} style={{ left: x } as CSSProperties}><span>{remainder === 0 ? String(centimeter) : ""}</span></div>;
}
