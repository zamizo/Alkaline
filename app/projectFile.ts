// Alkaline project files. Built-in loops are stored by id. Imported audio is
// embedded as little-endian float32 so a saved project opens with its samples.

import type { Clip, Project, Track } from "./engine";
import { CATEGORIES, LOOP_BY_ID, type Category, type Loop, type Note } from "./loops";

export const PROJECT_FORMAT = "alkaline-project";
export const PROJECT_VERSION = 1;

const INSTRUMENTS = new Set([
  "drums",
  "acid",
  "sub",
  "bass",
  "pad",
  "pluck",
  "arp",
  "piano",
  "stab",
  "riser",
  "vinyl",
  "downer",
  "revcym",
]);

const CATEGORY_SET = new Set<string>(CATEGORIES);
// Ten minutes of 44.1 kHz audio per channel. Longer files are refused.
const MAX_SAMPLES = 44100 * 60 * 10;

export class ProjectFileError extends Error {}

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function int(v: unknown, fallback: number, min: number, max: number) {
  return Math.round(num(v, fallback, min, max));
}

function bytesToB64(bytes: Uint8Array) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, Math.min(i + step, bytes.length));
    bin += String.fromCharCode(...slice);
  }
  return btoa(bin);
}

function b64ToBytes(text: string) {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function f32ToB64(samples: Float32Array) {
  const bytes = new Uint8Array(samples.byteLength);
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  return bytesToB64(bytes);
}

function b64ToF32(text: string) {
  if (typeof text !== "string" || !text) throw new ProjectFileError("That project file is damaged");
  const bytes = b64ToBytes(text);
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0 || bytes.byteLength / 4 > MAX_SAMPLES) {
    throw new ProjectFileError("That project file is damaged");
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Float32Array(copy);
}

function encodeLoop(loop: Loop) {
  return {
    id: loop.id,
    name: loop.name,
    category: loop.category,
    instrument: loop.instrument,
    bars: loop.bars,
    pitched: loop.pitched,
    gain: loop.gain,
    notes: loop.notes,
    source: loop.source
      ? { bpm: loop.source.bpm, channels: loop.source.channels.map(f32ToB64) }
      : undefined,
  };
}

function decodeNote(v: unknown): Note | null {
  if (!isRaw(v)) return null;
  return { s: num(v.s, 0, 0, 4096), n: int(v.n, 60, 0, 127), l: num(v.l, 1, 0, 4096), v: num(v.v, 0.8, 0, 1) };
}

function decodeLoop(v: unknown): Loop {
  if (!isRaw(v) || typeof v.id !== "string" || !v.id) throw new ProjectFileError("That project file is damaged");
  if (LOOP_BY_ID[v.id]) throw new ProjectFileError("That project file is damaged");
  const category = typeof v.category === "string" && CATEGORY_SET.has(v.category) ? (v.category as Category) : "Imported";
  const instrument = typeof v.instrument === "string" && INSTRUMENTS.has(v.instrument) ? v.instrument : "drums";
  let source: Loop["source"];
  if (v.source != null) {
    if (!isRaw(v.source) || !Array.isArray(v.source.channels) || v.source.channels.length === 0) {
      throw new ProjectFileError("That project file is damaged");
    }
    const channels = v.source.channels.map(b64ToF32);
    const len = channels[0].length;
    if (channels.some((c) => c.length !== len)) throw new ProjectFileError("That project file is damaged");
    source = { channels, bpm: num(v.source.bpm, 120, 20, 400) };
  }
  const notes = Array.isArray(v.notes) ? v.notes.map(decodeNote).filter((n): n is Note => n !== null) : [];
  return {
    id: v.id,
    name: typeof v.name === "string" && v.name ? v.name.slice(0, 120) : "Imported loop",
    category,
    instrument: instrument as Loop["instrument"],
    bars: int(v.bars, source ? 1 : 1, 1, 64),
    pitched: Boolean(v.pitched),
    gain: num(v.gain, 1, 0, 4),
    notes,
    source,
  };
}

function decodeClip(v: unknown): Clip {
  if (!isRaw(v)) throw new ProjectFileError("That project file is damaged");
  const start = num(v.start, 0, 0, 10000);
  const len = num(v.len, 1, 1, 10000);
  return {
    id: typeof v.id === "string" && v.id ? v.id : `c${start}-${len}`,
    start,
    len,
    offset: num(v.offset, 0, -10000, 10000),
  };
}

function decodeTrack(v: unknown): Track {
  if (!isRaw(v) || typeof v.loopId !== "string" || !Array.isArray(v.events)) {
    throw new ProjectFileError("That project file is damaged");
  }
  return {
    id: typeof v.id === "string" && v.id ? v.id : `t${v.loopId}`,
    loopId: v.loopId,
    name: typeof v.name === "string" && v.name ? v.name.slice(0, 120) : v.loopId,
    volume: num(v.volume, 0.8, 0, 1.5),
    pan: num(v.pan, 0, -1, 1),
    pitch: int(v.pitch, 0, -24, 24),
    mute: Boolean(v.mute),
    solo: Boolean(v.solo),
    events: v.events.map(decodeClip),
  };
}

export function serializeProject(project: Project, userLoops: Record<string, Loop>) {
  const used = new Set(project.tracks.map((t) => t.loopId));
  const loops = Object.values(userLoops)
    .filter((l) => !LOOP_BY_ID[l.id] && (used.has(l.id) || l.source))
    .map(encodeLoop);
  return JSON.stringify({
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    project: {
      bpm: project.bpm,
      key: project.key,
      loopOn: project.loopOn,
      loopStart: project.loopStart,
      loopEnd: project.loopEnd,
      tracks: project.tracks,
    },
    loops,
  });
}

export function parseProject(text: string): { project: Project; loops: Record<string, Loop> } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFileError("That file is not an Alkaline project");
  }
  if (!isRaw(raw) || raw.format !== PROJECT_FORMAT || raw.version !== PROJECT_VERSION || !isRaw(raw.project)) {
    throw new ProjectFileError("That file is not an Alkaline project");
  }
  const body = raw.project;
  if (!Array.isArray(body.tracks) || !Array.isArray(raw.loops)) {
    throw new ProjectFileError("That project file is damaged");
  }
  const loops: Record<string, Loop> = {};
  for (const item of raw.loops) {
    const loop = decodeLoop(item);
    loops[loop.id] = loop;
  }
  const tracks = body.tracks.map(decodeTrack);
  for (const track of tracks) {
    if (!LOOP_BY_ID[track.loopId] && !loops[track.loopId]) {
      throw new ProjectFileError("That project uses a loop this version does not have");
    }
  }
  const loopStart = int(body.loopStart, 0, 0, 10000);
  let loopEnd = int(body.loopEnd, loopStart + 4, 0, 10000);
  if (loopEnd <= loopStart) loopEnd = loopStart + 4;
  return {
    project: {
      bpm: num(body.bpm, 120, 40, 240),
      key: int(body.key, 0, 0, 11),
      loopOn: Boolean(body.loopOn),
      loopStart,
      loopEnd,
      tracks,
    },
    loops,
  };
}
