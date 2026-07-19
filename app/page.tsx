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
type UserSettings = { units: "in" | "mm" };
type PrecisionReading = { x: number; y: number; edge: TapeEdge; valueMm: number; label: string };
type MemoryEntry = { id: string; parts: string[]; savedAt: number };
type CalcTool = "none" | "total" | "area" | "perimeter" | "diagonal" | "volume" | "spaceDiagonal" | "circumference" | "diameter";
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
const DEFAULT_SETTINGS: UserSettings = { units: "in" };
const ROLL_CLICK_SRC = "data:audio/wav;base64,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";

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
const visibleDistanceRange = (offset: number, direction: number, pixelsPerUnit: number, span: number) => {
  const pad = Math.max(220, pixelsPerUnit * 3);
  const minPixel = -pad;
  const maxPixel = span + pad;
  const low = direction === 1 ? (minPixel - offset) / pixelsPerUnit : (offset - maxPixel) / pixelsPerUnit;
  const high = direction === 1 ? (maxPixel - offset) / pixelsPerUnit : (offset - minPixel) / pixelsPerUnit;
  return { low: Math.max(0, low), high: Math.max(0, high) };
};
const buildImperialTicks = (offset: number, direction: number, pixelsPerInch: number, span: number) => {
  const { low, high } = visibleDistanceRange(offset, direction, pixelsPerInch, span);
  const start = Math.max(0, Math.floor(low * 16) - 3);
  const end = Math.ceil(high * 16) + 3;
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
    const division = start + index;
    return {
      division,
      x: offset + direction * (division / 16) * pixelsPerInch,
      inch: Math.floor(division / 16),
      fraction: division % 16,
    };
  });
};
const buildMetricTicks = (offset: number, direction: number, pixelsPerMillimeter: number, span: number) => {
  const { low, high } = visibleDistanceRange(offset, direction, pixelsPerMillimeter, span);
  const start = Math.max(0, Math.floor(low) - 10);
  const end = Math.ceil(high) + 10;
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
    const millimeter = start + index;
    return {
      millimeter,
      x: offset + direction * millimeter * pixelsPerMillimeter,
      centimeter: Math.floor(millimeter / 10),
      remainder: millimeter % 10,
    };
  });
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
const parseInchParts = (label: string) => {
  const mixed = label.match(/^(\d+)\s+(\d+)\/(\d+)\s+in$/);
  if (mixed) return { whole: mixed[1], numerator: mixed[2], denominator: mixed[3] };
  const fraction = label.match(/^(\d+)\/(\d+)\s+in$/);
  if (fraction) return { whole: "", numerator: fraction[1], denominator: fraction[2] };
  const whole = label.match(/^(\d+)\s+in$/);
  if (whole) return { whole: whole[1], numerator: "", denominator: "" };
  return null;
};
const parseMeasurementLabel = (label: string) => {
  const inch = parseInchParts(label);
  if (inch) {
    const wholeValue = inch.whole ? Number(inch.whole) : 0;
    const fractionValue = inch.numerator && inch.denominator ? Number(inch.numerator) / Number(inch.denominator) : 0;
    return { valueMm: (wholeValue + fractionValue) * 25.4, units: "in" as const };
  }
  const metric = label.match(/^(\d+)\s+mm$/);
  if (metric) return { valueMm: Number(metric[1]), units: "mm" as const };
  return null;
};
const divideMeasurementLabel = (label: string, divisor: number) => {
  const parsed = parseMeasurementLabel(label);
  return parsed ? formatMeasurement(parsed.valueMm / divisor, parsed.units) : label;
};
const decimalLabel = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(digits)).toLocaleString(undefined, { maximumFractionDigits: digits });
};
const formatSquareMeasurement = (squareMm: number, units: UserSettings["units"]) => units === "in"
  ? `${decimalLabel(squareMm / (25.4 * 25.4))} sq in`
  : `${decimalLabel(squareMm)} mm²`;
const formatCubicMeasurement = (cubicMm: number, units: UserSettings["units"]) => units === "in"
  ? `${decimalLabel(cubicMm / (25.4 * 25.4 * 25.4))} cu in`
  : `${decimalLabel(cubicMm)} mm³`;
const splitLabel = (divisor: number) => {
  if (divisor === 2) return "Half";
  if (divisor === 3) return "Thirds";
  if (divisor === 4) return "Quarter";
  return String(divisor);
};
const calcToolLabel = (tool: CalcTool) => ({
  none: "Tools",
  total: "Total length",
  area: "Area",
  perimeter: "Perimeter",
  diagonal: "Diagonal",
  volume: "Volume",
  spaceDiagonal: "3D diagonal",
  circumference: "Circumference",
  diameter: "Diameter",
}[tool]);
const calcToolOptions: CalcTool[] = ["none", "total", "area", "perimeter", "diagonal", "volume", "spaceDiagonal", "circumference", "diameter"];
const memoryCalculation = (parts: string[], tool: CalcTool) => {
  if (tool === "none") return null;
  const parsed = parts.map(parseMeasurementLabel).filter((part): part is NonNullable<ReturnType<typeof parseMeasurementLabel>> => Boolean(part));
  const units = parsed[0]?.units ?? "in";
  const values = parsed.map((part) => part.valueMm);
  const need = (count: number) => values.length >= count;
  if (tool === "total") return need(1) ? { label: "Total", value: formatMeasurement(values.reduce((sum, value) => sum + value, 0), units) } : null;
  if (tool === "area") return need(2) ? { label: "Area", value: formatSquareMeasurement(values[0] * values[1], units) } : null;
  if (tool === "perimeter") return need(2) ? { label: "Perim.", value: formatMeasurement(2 * (values[0] + values[1]), units) } : null;
  if (tool === "diagonal") return need(2) ? { label: "Diag.", value: formatMeasurement(Math.hypot(values[0], values[1]), units) } : null;
  if (tool === "volume") return need(3) ? { label: "Volume", value: formatCubicMeasurement(values[0] * values[1] * values[2], units) } : null;
  if (tool === "spaceDiagonal") return need(3) ? { label: "3D diag.", value: formatMeasurement(Math.hypot(values[0], values[1], values[2]), units) } : null;
  if (tool === "circumference") return need(1) ? { label: "Circ.", value: formatMeasurement(values[0] * Math.PI, units) } : null;
  if (tool === "diameter") return need(1) ? { label: "Diam.", value: formatMeasurement(values[0] / Math.PI, units) } : null;
  return null;
};

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
  const [precisionSecondReading, setPrecisionSecondReading] = useState<PrecisionReading | null>(null);
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
  const precisionSecondReadingRef = useRef<PrecisionReading | null>(null);
  const precisionFrozenRef = useRef(false);

  const activateMotion = () => {
    detector.current.reset();
    homeRoll.current = { orientation: detectedOrientationRef.current, acceptedAt: performance.now() };
    motionEnabledRef.current = true;
    setMotionEnabled(true);
    setMotionNotice("");
  };

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
  useEffect(() => { precisionSecondReadingRef.current = precisionSecondReading; }, [precisionSecondReading]);
  useEffect(() => { precisionFrozenRef.current = precisionFrozen; }, [precisionFrozen]);
  useEffect(() => { localStorage.setItem(STORE.memory, JSON.stringify(memoryEntries)); }, [memoryEntries]);

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
    if ((!forward && !backward) || at - homeRoll.current.acceptedAt < 280) {
      homeRoll.current.orientation = nextOrientation;
      return;
    }
    const distanceMm = forward ? saved[fromIndex] : saved[toIndex];
    setTapeOffset((current) => current + (forward ? -distanceMm : distanceMm) * rulerScaleRef.current);
    homeRoll.current = { orientation: nextOrientation, acceptedAt: at };
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
    if (motionEnabledRef.current) {
      setMotionNotice("");
      return true;
    }
    try {
      const motion = typeof DeviceMotionEvent === "undefined" ? null : DeviceMotionEvent as unknown as ApplePermissionEvent;
      const orientation = typeof DeviceOrientationEvent === "undefined" ? null : DeviceOrientationEvent as unknown as ApplePermissionEvent;
      if (!motion && !orientation) {
        setMotionNotice("Motion sensors are not available in this browser.");
        return false;
      }
      setMotionNotice("");
      const requested = [motion, orientation].filter((event): event is ApplePermissionEvent => Boolean(event) && typeof event.requestPermission === "function");
      for (const event of requested) {
        const decision = await event.requestPermission?.();
        if (decision !== "granted") {
          setMotionNotice("Motion permission was not enabled. Tap Enable rolling and choose Allow.");
          return false;
        }
      }
      activateMotion();
      return true;
    } catch {
      setMotionNotice("Motion permission was not enabled. Tap Enable rolling and choose Allow.");
      return false;
    }
  };

  const clearPrecisionReading = () => {
    precisionReadingRef.current = null;
    precisionSecondReadingRef.current = null;
    precisionFrozenRef.current = false;
    setPrecisionReading(null);
    setPrecisionSecondReading(null);
    setPrecisionFrozen(false);
    setDraftMeasurements([]);
  };
  const dismissPrecisionReading = () => {
    precisionReadingRef.current = null;
    precisionSecondReadingRef.current = null;
    precisionFrozenRef.current = false;
    setPrecisionReading(null);
    setPrecisionSecondReading(null);
    setPrecisionFrozen(false);
  };
  const readingCoordinate = (clientX: number, clientY: number, edge: TapeEdge) => {
    const span = tapeSpanForEdge(edge);
    if (edge === "top") return span - clientX;
    if (edge === "right") return span - clientY;
    if (edge === "left") return clientY;
    return clientX;
  };
  const readingLineCoordinate = (reading: PrecisionReading) => (
    reading.edge === "left" || reading.edge === "right" ? reading.y : reading.x
  );
  const precisionValueMm = (first: PrecisionReading, second: PrecisionReading | null) => {
    if (!second) return first.valueMm;
    if (first.edge === second.edge) {
      return Math.abs(readingLineCoordinate(second) - readingLineCoordinate(first)) / rulerScaleRef.current;
    }
    return Math.abs(second.valueMm - first.valueMm);
  };
  const currentPrecisionLabel = () => {
    const first = precisionReadingRef.current;
    if (!first) return null;
    const second = precisionSecondReadingRef.current;
    const valueMm = precisionValueMm(first, second);
    return formatMeasurement(valueMm, settingsRef.current.units);
  };
  const capturePrecisionReading = (clientX: number, clientY: number, slot = 0) => {
    const edge = tapeEdgeForOrientation(detectedOrientationRef.current);
    const direction = reversedRef.current ? -1 : 1;
    const coordinate = readingCoordinate(clientX, clientY, edge);
    const valueMm = Math.max(0, ((coordinate - tapeOffsetRef.current) / direction) / rulerScaleRef.current);
    const reading = { x: clientX, y: clientY, edge, valueMm, label: formatMeasurement(valueMm, settingsRef.current.units) };
    if (slot === 1 && precisionReadingRef.current) {
      precisionSecondReadingRef.current = reading;
      setPrecisionSecondReading(reading);
    } else {
      precisionReadingRef.current = reading;
      if (precisionFrozenRef.current) {
        precisionSecondReadingRef.current = null;
        setPrecisionSecondReading(null);
      }
      setPrecisionReading(reading);
    }
    precisionFrozenRef.current = false;
    setPrecisionFrozen(false);
  };
  const freezePrecisionReading = () => {
    if (!precisionReadingRef.current) return;
    precisionFrozenRef.current = true;
    setPrecisionFrozen(true);
  };
  const saveMemoryReading = () => {
    const label = currentPrecisionLabel();
    const parts = label ? [...draftMeasurements, label] : draftMeasurements;
    if (!parts.length) return;
    setMemoryEntries((current) => [{ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, parts, savedAt: Date.now() }, ...current]);
    clearPrecisionReading();
  };
  const addMemoryPart = () => {
    const label = currentPrecisionLabel();
    if (!label) return;
    setDraftMeasurements((current) => [...current, label]);
    precisionReadingRef.current = null;
    precisionSecondReadingRef.current = null;
    precisionFrozenRef.current = false;
    setPrecisionReading(null);
    setPrecisionSecondReading(null);
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
    setScreen("settings");
  };
  const openMemory = () => {
    detector.current.stop();
    homeRoll.current = { orientation: "unknown", acceptedAt: 0 };
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
    const previousAlignment = runtime.lastAlignment;
    const savedAlignment = tapeOffset;
    const distancePx = Math.abs(savedAlignment - previousAlignment);
    const distanceMm = distancePx / rulerScale;
    if (distanceMm < 3) {
      setCalibrationNotice("Drag the tape to the new matching mark before saving this alignment.");
      return;
    }
    const index = runtime.turnCount % 4;
    runtime.draftValues[index] = distanceMm;
    runtime.lastAlignment = savedAlignment;
    runtime.lastOrientation = nextOrientation;
    runtime.orientationOrder[(index + 1) % 4] = nextOrientation;
    runtime.turnCount += 1;
    setCalibrationTurns(runtime.turnCount);
    if (runtime.turnCount < 4) {
      const nextIndex = runtime.turnCount % 4;
      const nextGuessMm = runtime.draftValues[(nextIndex + 2) % 4] ?? distanceMm;
      const stepDirection = Math.sign(savedAlignment - previousAlignment) || -1;
      setPredictedDistance(nextGuessMm);
      setTapeOffset(savedAlignment + stepDirection * nextGuessMm * rulerScale);
      setCalibrationNotice("Jumped to the next likely mark. Fine tune it after the next roll, then save.");
      return;
    }
    const values = runtime.draftValues.map((value) => value ?? 0);
    if (values.some((value) => value <= 3) || runtime.orientationOrder.length !== 4) {
      setCalibrationNotice("One of the four sides is still missing. Rotate once more and save it.");
      return;
    }
    setCalibration(values);
    setCalibrationOrder(runtime.orientationOrder);
    setPredictedDistance(null);
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
  const updateSettings = (nextSettings: UserSettings) => {
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
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
  const precisionDisplayLabel = precisionReading
    ? formatMeasurement(precisionValueMm(precisionReading, precisionSecondReading), settings.units)
    : "";
  const precisionIsDifference = Boolean(precisionReading && precisionSecondReading);

  return <main className="app-shell">
    {screen === "measure" && <MeasureScreen calibrated={calibration.every((value) => value > 0)} edge={measureEdge} motionEnabled={motionEnabled} motionNotice={motionNotice} precisionReading={precisionReading} precisionSecondReading={precisionSecondReading} precisionDisplayLabel={precisionDisplayLabel} precisionIsDifference={precisionIsDifference} precisionFrozen={precisionFrozen} draftMeasurements={draftMeasurements} onPrecisionPoint={capturePrecisionReading} onPrecisionFreeze={freezePrecisionReading} onPrecisionDismiss={dismissPrecisionReading} onSaveMeasurement={saveMemoryReading} onAddMeasurementPart={addMemoryPart} onEnableMotion={enableMotion} onMemory={openMemory} onSettings={openSettings}>{sharedTape(false, measureEdge)}</MeasureScreen>}
    {screen === "calibration" && <CalibrationScreen phase={calibrationPhase} detectedOrientation={detectedOrientation} turns={calibrationTurns} notice={calibrationNotice} rulerScale={rulerScale} onScale={(value) => setRulerScale(clamp(value, 2.5, 10))} onSaveScale={saveScale} onCaptureStart={captureStart} onSaveAlignment={saveAlignment} onBack={goToMeasure} onFinish={goToMeasure}>{sharedTape(true, calibrationPhase === "rolling" ? tapeEdgeForOrientation(detectedOrientation) : "bottom", false, false)}</CalibrationScreen>}
    {screen === "settings" && <SettingsScreen calibrated={calibration.every((value) => value > 0)} settings={settings} onChangeSettings={updateSettings} onReset={resetCalibration} onCalibrate={openCalibration} onBack={goToMeasure} />}
    {screen === "memory" && <MemoryScreen entries={memoryEntries} onDelete={(ids) => setMemoryEntries((current) => current.filter((entry) => !ids.includes(entry.id)))} onBack={goToMeasure} />}
  </main>;
}

function MeasureScreen({ calibrated, edge, motionEnabled, motionNotice, precisionReading, precisionSecondReading, precisionDisplayLabel, precisionIsDifference, precisionFrozen, draftMeasurements, onPrecisionPoint, onPrecisionFreeze, onPrecisionDismiss, onSaveMeasurement, onAddMeasurementPart, onEnableMotion, onMemory, onSettings, children }: {
  calibrated: boolean;
  edge: TapeEdge;
  motionEnabled: boolean;
  motionNotice: string;
  precisionReading: PrecisionReading | null;
  precisionSecondReading: PrecisionReading | null;
  precisionDisplayLabel: string;
  precisionIsDifference: boolean;
  precisionFrozen: boolean;
  draftMeasurements: string[];
  onPrecisionPoint: (clientX: number, clientY: number, slot?: number) => void;
  onPrecisionFreeze: () => void;
  onPrecisionDismiss: () => void;
  onSaveMeasurement: () => void;
  onAddMeasurementPart: () => void;
  onEnableMotion: () => Promise<boolean>;
  onMemory: () => void;
  onSettings: () => void;
  children: ReactNode;
}) {
  const holds = useRef<Map<number, { slot: number; startX: number; startY: number; measuring: boolean; timer: number | null; dismissOnTap: boolean }>>(new Map());
  const canMeasureFrom = (target: EventTarget | null) => target instanceof HTMLElement && !target.closest("button, .precision-readout");
  const startPreciseRead = (event: ReactPointerEvent<HTMLElement>) => {
    if (!canMeasureFrom(event.target)) return;
    const usedSlots = new Set(Array.from(holds.current.values()).map((hold) => hold.slot));
    if (usedSlots.has(0) && usedSlots.has(1)) return;
    const slot = usedSlots.has(0) ? 1 : 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const timer = window.setTimeout(() => {
      const hold = holds.current.get(pointerId);
      if (!hold || hold.measuring) return;
      hold.measuring = true;
      onPrecisionPoint(startX, startY, hold.slot);
    }, 220);
    holds.current.set(pointerId, { slot, startX, startY, measuring: false, timer, dismissOnTap: holds.current.size === 0 && Boolean(precisionReading && precisionFrozen) });
  };
  const movePreciseRead = (event: ReactPointerEvent<HTMLElement>) => {
    const hold = holds.current.get(event.pointerId);
    if (!hold) return;
    const moved = Math.hypot(event.clientX - hold.startX, event.clientY - hold.startY);
    if (!hold.measuring && moved > 8) {
      if (hold.timer) window.clearTimeout(hold.timer);
      hold.measuring = true;
    }
    if (!hold.measuring) return;
    onPrecisionPoint(event.clientX, event.clientY, hold.slot);
  };
  const endPreciseRead = (event: ReactPointerEvent<HTMLElement>) => {
    const hold = holds.current.get(event.pointerId);
    if (!hold) return;
    if (hold.timer) window.clearTimeout(hold.timer);
    const wasMeasuring = hold.measuring;
    const dismissOnTap = hold.dismissOnTap;
    holds.current.delete(event.pointerId);
    if (wasMeasuring) onPrecisionFreeze();
    else if (dismissOnTap && holds.current.size === 0) onPrecisionDismiss();
  };
  const lineStyle = (reading: PrecisionReading) => (reading.edge === "left" || reading.edge === "right"
    ? { top: reading.y } as CSSProperties
    : { left: reading.x } as CSSProperties);
  return <section className={`measure-screen measure-orientation-${edge}`} onPointerDown={startPreciseRead} onPointerMove={movePreciseRead} onPointerUp={endPreciseRead} onPointerCancel={endPreciseRead}>
    <div className="measure-stage">
      <div className="home-status-cluster">
        <span className={`measure-status ${calibrated ? "ready" : "calibrate"}`}>{calibrated ? "Calibrated" : "Calibrate"}{calibrated && motionEnabled && <span className="status-dot"> · </span>} {calibrated && motionEnabled && <span className="rolling-inline">Rolling live</span>}</span>
        <span className="orientation-reminder">Lock phone orientation first</span>
        {calibrated && !motionEnabled && <button className="enable-motion-button" onClick={() => void onEnableMotion()}>Enable rolling</button>}
        {motionNotice && !motionEnabled && <span className="rolling-warning">{motionNotice}</span>}
      </div>
      <div className="home-actions" aria-label="PhoneRoll controls">
        <button className="home-icon-button memory-icon" aria-label="Measurement memory" title="Measurement memory" onClick={onMemory} />
        <button className="home-icon-button settings-icon" aria-label="Settings" title="Settings" onClick={onSettings}>⚙</button>
      </div>
    </div>
    {precisionReading && <div className={`precision-line precision-line-${precisionReading.edge}`} style={lineStyle(precisionReading)} aria-hidden="true" />}
    {precisionSecondReading && <div className={`precision-line precision-line-secondary precision-line-${precisionSecondReading.edge}`} style={lineStyle(precisionSecondReading)} aria-hidden="true" />}
    {precisionReading && <div className={`precision-layer precision-layer-${edge}`}>
      <div className={`precision-readout ${draftMeasurements.length ? "has-pending" : ""}`} role="status" aria-live="polite">
        {draftMeasurements.length > 0 && <span className="precision-pending"><MeasurementParts parts={draftMeasurements} compact /><em>x</em></span>}
        {precisionIsDifference && <span className="precision-mode-label">between lines</span>}
        <strong><MeasurementText label={precisionDisplayLabel} /></strong>
        <div className="precision-actions">
          <button onClick={onAddMeasurementPart}>By</button>
          <button onClick={onSaveMeasurement}>Save</button>
        </div>
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
  const [splitDivisor, setSplitDivisor] = useState(0);
  const [calcTool, setCalcTool] = useState<CalcTool>("none");
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
      <button onClick={onBack}>‹ Ruler</button>
      {selecting && <button className="delete-memory-button" disabled={!selectedIds.length} onClick={deleteSelected}>Delete</button>}
      <span>Memory</span>
    </header>
    <div className="memory-card">
      <div className="memory-title-row">
        {selecting ? <button className="memory-title-back" onClick={leaveSelection}>‹ Back</button> : <h1>Saved measurements</h1>}
        {entries.length > 0 && <button className="memory-select-button" onClick={selecting ? selectAll : () => setSelecting(true)}>{selecting ? (allSelected ? "Clear all" : "Select all") : "Select"}</button>}
      </div>
      {entries.length > 0 && !selecting && <div className="memory-tools-row">
        <label className="split-control" aria-label="Memory splits"><select value={splitDivisor} onChange={(event) => setSplitDivisor(Number(event.target.value))}><option value={0}>Splits</option>{Array.from({ length: 19 }, (_, index) => index + 2).map((value) => <option value={value} key={value}>{splitLabel(value)}</option>)}</select></label>
        <label className="calc-control" aria-label="Memory tools"><select value={calcTool} onChange={(event) => setCalcTool(event.target.value as CalcTool)}>{calcToolOptions.map((tool) => <option value={tool} key={tool}>{calcToolLabel(tool)}</option>)}</select></label>
      </div>}
      {entries.length === 0 ? <p className="empty-memory">Hold on the ruler, then save a reading here.</p> : <div className={`memory-list ${selecting ? "is-selecting" : ""}`}>{entries.map((entry) => {
        const selected = selectedIds.includes(entry.id);
        const splitParts = splitDivisor ? entry.parts.map((part) => divideMeasurementLabel(part, splitDivisor)) : [];
        const calculation = memoryCalculation(entry.parts, calcTool);
        return <button className={`memory-row ${selected ? "selected" : ""}`} key={entry.id} onClick={() => selecting && toggleEntry(entry.id)} disabled={!selecting}>
          {selecting && <span className="memory-check" aria-hidden="true">{selected ? "✓" : ""}</span>}
          <strong><MeasurementParts parts={entry.parts} compact /></strong>
          {splitDivisor > 0 && <span className="memory-split"><small>÷{splitDivisor}</small><MeasurementParts parts={splitParts} compact /></span>}
          {calculation && <span className="memory-calc"><small>{calculation.label}</small><span>{calculation.value}</span></span>}
          <span>{new Date(entry.savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        </button>;
      })}</div>}
    </div>
  </section>;
}

function MeasurementText({ label, compact = false }: { label: string; compact?: boolean }) {
  const inchParts = parseInchParts(label);
  if (!inchParts) return <span className={`measurement-text ${compact ? "compact" : ""}`}>{label}</span>;
  const { whole, numerator, denominator } = inchParts;
  return <span className={`measurement-text inch-format ${compact ? "compact" : ""}`}>
    {whole && <span className="whole-number">{whole}</span>}
    {numerator && denominator && <span className="stacked-fraction"><span>{numerator}</span><span>{denominator}</span></span>}
    <span className="unit-label">in</span>
  </span>;
}

function MeasurementParts({ parts, compact = false }: { parts: string[]; compact?: boolean }) {
  return <>{parts.map((part, index) => <span className="memory-part" key={`${part}-${index}`}><MeasurementText label={part} compact={compact} />{index < parts.length - 1 && <em>x</em>}</span>)}</>;
}

function SettingsScreen({ calibrated, settings, onChangeSettings, onReset, onCalibrate, onBack }: { calibrated: boolean; settings: UserSettings; onChangeSettings: (settings: UserSettings) => void; onReset: () => void; onCalibrate: () => void; onBack: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const setSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => onChangeSettings({ ...settings, [key]: value });
  return <section className="settings-screen"><header className="page-header"><button onClick={onBack}>‹ Ruler</button><span>Settings</span></header><div className="settings-card"><h1>Ruler settings</h1><div className="settings-group"><div className="setting-row"><div><strong>Ruler labels</strong><span>Choose inches or millimeters</span></div><div className="segmented-control"><button className={settings.units === "in" ? "selected" : ""} onClick={() => setSetting("units", "in")}>in</button><button className={settings.units === "mm" ? "selected" : ""} onClick={() => setSetting("units", "mm")}>mm</button></div></div></div><div className="settings-group calibration-settings"><strong>Tape calibration</strong><p>{calibrated ? "Four orientation-aware rolling distances are saved on this device." : "No complete tape calibration is saved yet."}</p><button className="action-button calibrate-settings-button" onClick={onCalibrate}>Calibrate tape</button>{confirming ? <div className="reset-row"><button className="action-button danger" onClick={() => { onReset(); setConfirming(false); }}>Reset calibration</button><button className="plain-button" onClick={() => setConfirming(false)}>Cancel</button></div> : <button className="plain-button danger-text" onClick={() => setConfirming(true)}>Reset calibration</button>}</div></div></section>;
}

function ToggleRow({ label, detail, checked, disabled = false, onChange }: { label: string; detail: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <div className={`setting-row ${disabled ? "disabled" : ""}`}><div><strong>{label}</strong><span>{detail}</span></div><button className={`switch ${checked ? "on" : ""}`} aria-label={label} aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></div>;
}

function TapeRuler({ offset, scaleMm, units, edge, reversed, draggable, showControls, showEnableHint, motionNotice, onOffset, onDirection, onReset, onEnableMotion }: { offset: number; scaleMm: number; units: "in" | "mm"; edge: TapeEdge; reversed: boolean; draggable: boolean; showControls: boolean; showEnableHint: boolean; motionNotice: string; onOffset: (value: number) => void; onDirection: (reversed: boolean) => void; onReset: () => void; onEnableMotion: () => void | Promise<boolean> }) {
  const drag = useRef<{ pointerId: number; startCoordinate: number; startOffset: number; edge: TapeEdge } | null>(null);
  const pixelsPerUnit = units === "in" ? scaleMm * 25.4 : scaleMm;
  const direction = reversed ? -1 : 1;
  const tapeSpan = tapeSpanForEdge(edge);
  const imperialTicks = units === "in" ? buildImperialTicks(offset, direction, pixelsPerUnit, tapeSpan) : [];
  const metricTicks = units === "mm" ? buildMetricTicks(offset, direction, pixelsPerUnit, tapeSpan) : [];
  const dragCoordinate = (event: ReactPointerEvent<HTMLDivElement>, tapeEdge: TapeEdge) => {
    if (tapeEdge === "top") return -event.clientX;
    if (tapeEdge === "right") return -event.clientY;
    if (tapeEdge === "left") return event.clientY;
    return event.clientX;
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
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
  return <>
    {showControls && <div className={`tape-control-stage control-orientation-${edge}`}>
      <div className="tape-controls" aria-label="Ruler direction and zero controls"><button className={!reversed ? "selected" : ""} aria-label="Measure right" onClick={() => onDirection(false)}>→</button><button className="zero-button" onClick={onReset}>0</button><button className={reversed ? "selected" : ""} aria-label="Measure left" onClick={() => onDirection(true)}>←</button></div>
    </div>}
    <aside className={`tape-ruler edge-${edge} ${showEnableHint ? "is-inactive" : ""}`} aria-label="Construction tape ruler">
      <div className={`tape-viewport ${draggable ? "is-draggable" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        {showEnableHint && <button className="motion-hint" onClick={() => void onEnableMotion()}>Tap to enable rolling</button>}
        {readiness && <span className="motion-status">{readiness}</span>}
        {units === "in"
          ? imperialTicks.map(({ division, x, inch, fraction }) => <TapeTick key={division} x={x} inch={inch} fraction={fraction} />)
          : metricTicks.map(({ millimeter, x, centimeter, remainder }) => <MetricTick key={millimeter} x={x} centimeter={centimeter} remainder={remainder} />)}
      </div>
    </aside>
  </>;
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
