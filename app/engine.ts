// Audio engine: synth voices, loop rendering, time-stretch / pitch-shift,
// the transport scheduler, preview and WAV mixdown.

import { DRUM, type Instrument, type Loop } from "./loops";

export type Clip = { id: string; start: number; len: number; offset: number };

export type Track = {
  id: string;
  loopId: string;
  name: string;
  volume: number; // linear gain, 0..1.5
  pan: number; // -1..1
  pitch: number; // per-track semitones, on top of the project key
  mute: boolean;
  solo: boolean;
  events: Clip[];
};

export type Project = {
  bpm: number;
  key: number; // 0 = C .. 11 = B
  tracks: Track[];
  loopOn: boolean;
  loopStart: number;
  loopEnd: number;
};

const SR = 44100;

export const barSeconds = (bpm: number) => 240 / bpm;

// Project key change in semitones, picking the shortest direction (C -> A is -3, not +9)
export const keyShift = (key: number) => (key > 6 ? key - 12 : key);

export const semitonesFor = (loop: Loop, track: Track, project: Project) =>
  (loop.pitched ? keyShift(project.key) : 0) + track.pitch;

export const songEnd = (project: Project) =>
  project.tracks.reduce((m, t) => t.events.reduce((mm, e) => Math.max(mm, e.start + e.len), m), 0);

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------
// Synth voices (work on both AudioContext and OfflineAudioContext)
// ---------------------------------------------------------------------------

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

function noise(ctx: BaseAudioContext, t: number, len: number) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  src.start(t, Math.random());
  src.stop(t + len);
  return src;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, freq: number, t: number, stop: number, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  o.start(t);
  o.stop(stop);
  return o;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

// Linear ADSR; returns the gain node and the time the voice is silent
function adsr(
  ctx: BaseAudioContext,
  t: number,
  dur: number,
  peak: number,
  a: number,
  d: number,
  s: number,
  r: number,
) {
  const g = ctx.createGain();
  const p = g.gain;
  p.setValueAtTime(0, t);
  if (dur > a + d) {
    p.linearRampToValueAtTime(peak, t + a);
    p.linearRampToValueAtTime(peak * s, t + a + d);
    p.setValueAtTime(peak * s, t + dur);
    p.linearRampToValueAtTime(0, t + dur + r);
  } else {
    p.linearRampToValueAtTime(peak, t + Math.min(a, dur));
    p.linearRampToValueAtTime(0, t + dur + r);
  }
  return { g, end: t + dur + r + 0.02 };
}

function decay(ctx: BaseAudioContext, t: number, peak: number, len: number) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  return g;
}

function drum(ctx: BaseAudioContext, out: AudioNode, t: number, id: number, v: number) {
  switch (id) {
    case DRUM.kick: {
      const o = osc(ctx, "sine", 160, t, t + 0.5);
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      o.connect(decay(ctx, t, v, 0.45)).connect(out);
      noise(ctx, t, 0.02).connect(filter(ctx, "highpass", 3000)).connect(decay(ctx, t, 0.25 * v, 0.012)).connect(out);
      break;
    }
    case DRUM.snare: {
      noise(ctx, t, 0.25).connect(filter(ctx, "bandpass", 2500, 0.6)).connect(decay(ctx, t, 0.9 * v, 0.2)).connect(out);
      const o = osc(ctx, "triangle", 200, t, t + 0.15);
      o.frequency.exponentialRampToValueAtTime(150, t + 0.1);
      o.connect(decay(ctx, t, 0.5 * v, 0.12)).connect(out);
      break;
    }
    case DRUM.clap: {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < 3; i++) {
        g.gain.setValueAtTime(0.8 * v, t + i * 0.012);
        g.gain.exponentialRampToValueAtTime(0.1 * v, t + i * 0.012 + 0.01);
      }
      g.gain.setValueAtTime(0.8 * v, t + 0.036);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      noise(ctx, t, 0.3).connect(filter(ctx, "bandpass", 1100, 1.2)).connect(g).connect(out);
      break;
    }
    case DRUM.chh:
    case DRUM.ohh: {
      const len = id === DRUM.chh ? 0.05 : 0.32;
      noise(ctx, t, len + 0.02).connect(filter(ctx, "highpass", 7500)).connect(decay(ctx, t, 0.5 * v, len)).connect(out);
      break;
    }
    case DRUM.crash:
      noise(ctx, t, 1.7).connect(filter(ctx, "highpass", 4500)).connect(decay(ctx, t, 0.45 * v, 1.6)).connect(out);
      break;
    case DRUM.rim:
      osc(ctx, "triangle", 800, t, t + 0.06).connect(decay(ctx, t, 0.5 * v, 0.04)).connect(out);
      noise(ctx, t, 0.03).connect(filter(ctx, "highpass", 3000)).connect(decay(ctx, t, 0.3 * v, 0.02)).connect(out);
      break;
    case DRUM.tom: {
      const o = osc(ctx, "sine", 140, t, t + 0.4);
      o.frequency.exponentialRampToValueAtTime(85, t + 0.25);
      o.connect(decay(ctx, t, 0.8 * v, 0.35)).connect(out);
      break;
    }
    case DRUM.shaker: {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.4 * v, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      noise(ctx, t, 0.1).connect(filter(ctx, "bandpass", 7000, 2)).connect(g).connect(out);
      break;
    }
  }
}

function voice(
  ctx: BaseAudioContext,
  out: AudioNode,
  inst: Instrument,
  t: number,
  midi: number,
  dur: number,
  v: number,
) {
  const f = mtof(midi);
  switch (inst) {
    case "drums":
      return drum(ctx, out, t, midi, v);
    case "acid": {
      const { g, end } = adsr(ctx, t, dur * 0.9, 0.4 * v, 0.003, 0.05, 0.9, 0.03);
      const lp = filter(ctx, "lowpass", 180, 12);
      lp.frequency.setValueAtTime(180 + v * v * 3200, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + 0.2);
      osc(ctx, "sawtooth", f, t, end).connect(lp).connect(g).connect(out);
      return;
    }
    case "sub": {
      const { g, end } = adsr(ctx, t, dur, 0.6 * v, 0.005, 0.1, 0.9, 0.08);
      osc(ctx, "sine", f, t, end).connect(g);
      const h = ctx.createGain();
      h.gain.value = 0.15;
      osc(ctx, "triangle", f * 2, t, end).connect(h).connect(g);
      g.connect(out);
      return;
    }
    case "bass": {
      const { g, end } = adsr(ctx, t, dur * 0.85, 0.35 * v, 0.003, 0.2, 0.6, 0.05);
      const lp = filter(ctx, "lowpass", 1600, 4);
      lp.frequency.setValueAtTime(1600, t);
      lp.frequency.exponentialRampToValueAtTime(350, t + 0.15);
      osc(ctx, "square", f, t, end).connect(lp);
      osc(ctx, "sawtooth", f, t, end, 6).connect(lp);
      lp.connect(g).connect(out);
      return;
    }
    case "pad": {
      const { g, end } = adsr(ctx, t, dur, 0.12 * v, 0.35, 0.5, 0.8, 0.8);
      const lp = filter(ctx, "lowpass", 1200, 1);
      [-9, 0, 9].forEach((det, i) => {
        const p = ctx.createStereoPanner();
        p.pan.value = (i - 1) * 0.7;
        osc(ctx, "sawtooth", f, t, end, det).connect(p).connect(lp);
      });
      lp.connect(g).connect(out);
      return;
    }
    case "pluck": {
      const { g, end } = adsr(ctx, t, dur, 0.3 * v, 0.002, 0.35, 0, 0.1);
      const lp = filter(ctx, "lowpass", 5000, 6);
      lp.frequency.setValueAtTime(5000, t);
      lp.frequency.exponentialRampToValueAtTime(300, t + 0.25);
      osc(ctx, "sawtooth", f, t, end + 0.5).connect(lp);
      osc(ctx, "square", f * 2, t, end + 0.5).connect(lp);
      lp.connect(g).connect(out);
      return;
    }
    case "arp": {
      const { g, end } = adsr(ctx, t, dur * 0.7, 0.22 * v, 0.002, 0.08, 0.4, 0.04);
      osc(ctx, "square", f, t, end).connect(filter(ctx, "lowpass", 2800, 3)).connect(g).connect(out);
      return;
    }
    case "piano": {
      const { g, end } = adsr(ctx, t, dur, 0.25 * v, 0.003, 1.5, 0, 0.15);
      osc(ctx, "triangle", f, t, end).connect(g);
      const h = ctx.createGain();
      h.gain.value = 0.3;
      osc(ctx, "sine", f * 2, t, end).connect(h).connect(g);
      g.connect(out);
      return;
    }
    case "stab": {
      const { g, end } = adsr(ctx, t, dur, 0.2 * v, 0.002, 0.25, 0, 0.05);
      const lp = filter(ctx, "lowpass", 4000, 2);
      lp.frequency.setValueAtTime(4000, t);
      lp.frequency.exponentialRampToValueAtTime(700, t + 0.2);
      osc(ctx, "sawtooth", f, t, end, -10).connect(lp);
      osc(ctx, "sawtooth", f, t, end, 10).connect(lp);
      lp.connect(g).connect(out);
      return;
    }
    case "riser": {
      const bp = filter(ctx, "bandpass", 300, 3);
      bp.frequency.setValueAtTime(300, t);
      bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.7 * v, t + dur);
      g.gain.linearRampToValueAtTime(0, t + dur + 0.01);
      noise(ctx, t, dur + 0.02).connect(bp).connect(g).connect(out);
      return;
    }
    case "downer": {
      const o = osc(ctx, "sine", 900, t, t + dur);
      o.frequency.exponentialRampToValueAtTime(50, t + dur * 0.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5 * v, t);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g).connect(out);
      const lp = filter(ctx, "lowpass", 6000);
      lp.frequency.exponentialRampToValueAtTime(200, t + dur);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.3 * v, t);
      ng.gain.linearRampToValueAtTime(0, t + dur);
      noise(ctx, t, dur).connect(lp).connect(ng).connect(out);
      return;
    }
    case "revcym": {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.6 * v, t + dur * 0.97);
      g.gain.linearRampToValueAtTime(0, t + dur);
      noise(ctx, t, dur).connect(filter(ctx, "highpass", 3000)).connect(g).connect(out);
      return;
    }
    case "vinyl": {
      const len = Math.floor(dur * ctx.sampleRate);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += 0.05 * (Math.random() * 2 - 1 - lp);
        d[i] = lp * 0.3;
        if (Math.random() < 0.0004) {
          const amp = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.5);
          for (let j = 0; j < 30 && i + j < len; j++) d[i + j] += amp * Math.exp(-j / 4);
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = v;
      src.connect(g).connect(out);
      src.start(t);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Time-stretch (WSOLA) and pitch-shift (stretch + resample)
// ---------------------------------------------------------------------------

const FRAME = 2048;
const HOP = 512;
const TOL = 512;
const HANN = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));

// Stretch duration by `stretch` without changing pitch. Input is treated as a
// seamless loop so frames that run past the end wrap around to the start.
function wsola(chs: Float32Array[], stretch: number): Float32Array[] {
  const inLen = chs[0].length;
  if (Math.abs(stretch - 1) < 1e-4) return chs.map((c) => c.slice());
  const outLen = Math.round(inLen * stretch);
  const mono = new Float32Array(inLen);
  chs.forEach((c) => c.forEach((s, i) => (mono[i] += s / chs.length)));
  const at = (i: number) => mono[((i % inLen) + inLen) % inLen];

  const out = chs.map(() => new Float32Array(outLen + FRAME));
  const wsum = new Float32Array(outLen + FRAME);
  const ha = HOP / stretch;
  let prev = 0;

  for (let k = 0; k * HOP < outLen; k++) {
    const outPos = k * HOP;
    let pos = 0;
    if (k > 0) {
      const natural = prev + HOP;
      const nominal = Math.round(k * ha);
      let best = -Infinity;
      for (let d = -TOL; d <= TOL; d += 4) {
        const cand = nominal + d;
        let dot = 0;
        let energy = 1e-9;
        for (let i = 0; i < FRAME / 2; i += 8) {
          const c = at(cand + i);
          dot += at(natural + i) * c;
          energy += c * c;
        }
        const score = dot / Math.sqrt(energy);
        if (score > best) {
          best = score;
          pos = cand;
        }
      }
    }
    for (let ch = 0; ch < chs.length; ch++) {
      const src = chs[ch];
      const dst = out[ch];
      for (let i = 0; i < FRAME; i++) dst[outPos + i] += src[(((pos + i) % inLen) + inLen) % inLen] * HANN[i];
    }
    for (let i = 0; i < FRAME; i++) wsum[outPos + i] += HANN[i];
    prev = pos;
  }

  return out.map((c) => {
    const res = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) res[i] = wsum[i] > 1e-3 ? c[i] / wsum[i] : 0;
    return res;
  });
}

function resample(chs: Float32Array[], ratio: number, outLen: number): Float32Array[] {
  return chs.map((c) => {
    const n = c.length;
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio;
      const i0 = Math.floor(x);
      const fr = x - i0;
      out[i] = c[i0 % n] * (1 - fr) + c[(i0 + 1) % n] * fr;
    }
    return out;
  });
}

// Change tempo by `tempoRatio` (2 = twice as fast) and pitch by `semis`,
// independently, landing on exactly `outLen` samples.
export function stretchPitch(chs: Float32Array[], tempoRatio: number, semis: number, outLen: number) {
  const p = Math.pow(2, semis / 12);
  const stretched = wsola(chs, p / tempoRatio);
  return resample(stretched, stretched[0].length / outLen, outLen);
}

// ---------------------------------------------------------------------------
// Loop rendering
// ---------------------------------------------------------------------------

function toBuffer(chs: Float32Array[]) {
  const buf = new AudioBuffer({ length: chs[0].length, numberOfChannels: 2, sampleRate: SR });
  buf.getChannelData(0).set(chs[0]);
  buf.getChannelData(1).set(chs[1] ?? chs[0]);
  return buf;
}

async function renderLoop(loop: Loop, bpm: number, semis: number): Promise<AudioBuffer> {
  const loopLen = Math.round(loop.bars * barSeconds(bpm) * SR);

  // Imported audio: real time-stretch + pitch-shift from its native tempo
  if (loop.source) {
    const ratio = bpm / loop.source.bpm;
    return toBuffer(stretchPitch(loop.source.channels, ratio, semis, loopLen));
  }

  const stepSec = barSeconds(bpm) / 16;
  const tail = SR * 3;
  const ctx = new OfflineAudioContext(2, loopLen + tail, SR);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const transpose = loop.pitched ? semis : 0;
  for (const nt of loop.notes) {
    const midi = loop.instrument === "drums" ? nt.n : nt.n + transpose;
    voice(ctx, out, loop.instrument, nt.s * stepSec, midi, nt.l * stepSec, nt.v);
  }
  const rendered = await ctx.startRendering();

  // Fold the release tail back onto the start so the loop repeats seamlessly
  let chs: Float32Array[] = [0, 1].map((ch) => {
    const d = rendered.getChannelData(ch);
    const res = d.slice(0, loopLen);
    for (let i = loopLen; i < d.length; i++) res[(i - loopLen) % loopLen] += d[i];
    return res;
  });

  // Unpitched loops (drums, FX) ignore the project key but still follow the track pitch
  if (!loop.pitched && semis !== 0) chs = stretchPitch(chs, 1, semis, loopLen);

  let peak = 1e-6;
  chs.forEach((c) => c.forEach((s) => (peak = Math.max(peak, Math.abs(s)))));
  const norm = (0.7 * loop.gain) / peak;
  chs.forEach((c) => c.forEach((s, i) => (c[i] = s * norm)));
  return toBuffer(chs);
}

// ---------------------------------------------------------------------------
// Imported audio
// ---------------------------------------------------------------------------

export async function decodeLoopFile(file: File): Promise<{ channels: Float32Array[]; bpm: number; bars: number }> {
  const ctx = new OfflineAudioContext(2, 1, SR);
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  // resample to engine rate via a quick offline render
  const len = Math.ceil(decoded.duration * SR);
  const rs = new OfflineAudioContext(2, len, SR);
  const src = rs.createBufferSource();
  src.buffer = decoded;
  src.connect(rs.destination);
  src.start();
  const buf = await rs.startRendering();
  const channels = [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()];
  return { channels, ...guessTempo(decoded.duration) };
}

// Assume a 4/4 loop of 1..16 bars; pick the bar count whose tempo is closest to 120
export function guessTempo(seconds: number) {
  let best = { bpm: 120, bars: 1 };
  let bestDist = Infinity;
  for (const bars of [1, 2, 4, 8, 16]) {
    const bpm = (bars * 240) / seconds;
    const dist = Math.abs(Math.log2(bpm / 120));
    if (bpm >= 60 && bpm <= 200 && dist < bestDist) {
      bestDist = dist;
      best = { bpm: Math.round(bpm * 100) / 100, bars };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

type TrackNodes = { gain: GainNode; pan: StereoPannerNode; meter: AnalyserNode };

const EPS = 1e-6;

export class Engine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private meterL!: AnalyserNode;
  private meterR!: AnalyserNode;
  private previewGain!: GainNode;
  private previewMeter!: AnalyserNode;
  private nodes = new Map<string, TrackNodes>();
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private ready = new Map<string, AudioBuffer>();
  private sources = new Set<AudioBufferSourceNode>();
  private previewSrc: AudioBufferSourceNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chunks: { time: number; pos: number; barSec: number }[] = [];
  private nextTime = 0;
  private nextPos = 0;
  private scratch = new Float32Array(1024);

  loops: Record<string, Loop> = {};
  playing = false;
  getProject: () => Project = () => {
    throw new Error("no project");
  };
  onBuffer?: (key: string, buf: AudioBuffer) => void;
  onEnded?: () => void;

  private ensureCtx() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.master = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    this.meterL = ctx.createAnalyser();
    this.meterR = ctx.createAnalyser();
    this.meterL.fftSize = this.meterR.fftSize = 1024;
    this.master.connect(ctx.destination);
    this.master.connect(split);
    split.connect(this.meterL, 0);
    split.connect(this.meterR, 1);
    this.previewGain = ctx.createGain();
    this.previewMeter = ctx.createAnalyser();
    this.previewMeter.fftSize = 1024;
    this.previewGain.connect(this.previewMeter);
    this.previewGain.connect(ctx.destination);
    return ctx;
  }

  static bufferKey(loopId: string, bpm: number, semis: number) {
    return `${loopId}|${bpm.toFixed(3)}|${semis}`;
  }

  keyFor(track: Track, project: Project) {
    const loop = this.loops[track.loopId];
    return Engine.bufferKey(track.loopId, project.bpm, semitonesFor(loop, track, project));
  }

  getBuffer(loopId: string, bpm: number, semis: number) {
    const key = Engine.bufferKey(loopId, bpm, semis);
    let p = this.buffers.get(key);
    if (!p) {
      p = renderLoop(this.loops[loopId], bpm, semis).then((b) => {
        this.ready.set(key, b);
        this.onBuffer?.(key, b);
        return b;
      });
      this.buffers.set(key, p);
    }
    return p;
  }

  // Drop cached renders of a loop after its source settings change
  invalidate(loopId: string) {
    for (const k of [...this.buffers.keys()]) {
      if (k.startsWith(loopId + "|")) {
        this.buffers.delete(k);
        this.ready.delete(k);
      }
    }
  }

  readyBuffer(key: string) {
    return this.ready.get(key);
  }

  prepare(project: Project) {
    return Promise.all(
      project.tracks.map((t) =>
        this.getBuffer(t.loopId, project.bpm, semitonesFor(this.loops[t.loopId], t, project)),
      ),
    );
  }

  // Forget rendered buffers that no current track uses
  prune(project: Project) {
    const keep = new Set(project.tracks.map((t) => this.keyFor(t, project)));
    for (const k of this.buffers.keys()) {
      if (!keep.has(k)) {
        this.buffers.delete(k);
        this.ready.delete(k);
      }
    }
  }

  syncMix(project: Project) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const anySolo = project.tracks.some((t) => t.solo);
    const ids = new Set(project.tracks.map((t) => t.id));
    for (const [id, n] of this.nodes) {
      if (!ids.has(id)) {
        n.gain.disconnect();
        this.nodes.delete(id);
      }
    }
    for (const t of project.tracks) {
      let n = this.nodes.get(t.id);
      if (!n) {
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner();
        const meter = ctx.createAnalyser();
        meter.fftSize = 1024;
        gain.connect(pan).connect(this.master);
        pan.connect(meter);
        n = { gain, pan, meter };
        this.nodes.set(t.id, n);
      }
      const audible = !t.mute && (!anySolo || t.solo);
      n.gain.gain.setTargetAtTime(audible ? t.volume : 0, ctx.currentTime, 0.01);
      n.pan.pan.setTargetAtTime(t.pan, ctx.currentTime, 0.01);
    }
  }

  setMaster(v: number) {
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setPreviewVolume(v: number) {
    if (this.ctx) this.previewGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  play(from: number) {
    const ctx = this.ensureCtx();
    this.stop();
    this.syncMix(this.getProject());
    this.playing = true;
    this.nextPos = from;
    this.nextTime = ctx.currentTime + 0.06;
    this.chunks = [];
    this.tick();
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.chunks = [];
  }

  position(): number | null {
    if (!this.playing || !this.ctx) return null;
    const now = this.ctx.currentTime;
    let c = this.chunks[0];
    if (!c) return this.nextPos;
    for (const ch of this.chunks) if (ch.time <= now) c = ch;
    return c.pos + Math.max(0, now - c.time) / c.barSec;
  }

  private tick() {
    const ctx = this.ctx!;
    const project = this.getProject();
    const barSec = barSeconds(project.bpm);
    const end = songEnd(project);
    while (this.playing && this.nextTime < ctx.currentTime + 0.15) {
      const p = this.nextPos;
      if (!project.loopOn && p >= end + 1) {
        this.stop();
        this.onEnded?.();
        return;
      }
      let e = Math.floor(p + EPS) + 1;
      if (project.loopOn && p < project.loopEnd - EPS) e = Math.min(e, project.loopEnd);
      const dur = (e - p) * barSec;

      for (const t of project.tracks) {
        const ev = t.events.find((c) => c.start <= p + EPS && p < c.start + c.len - EPS);
        if (!ev) continue;
        const buf = this.ready.get(this.keyFor(t, project));
        const node = this.nodes.get(t.id);
        if (!buf || !node) continue;
        const bars = this.loops[t.loopId].bars;
        const phase = (((p - ev.start + ev.offset) % bars) + bars) % bars;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(node.gain);
        src.start(this.nextTime, Math.min(phase * barSec, buf.duration - 1e-4), dur);
        src.onended = () => this.sources.delete(src);
        this.sources.add(src);
      }

      this.chunks.push({ time: this.nextTime, pos: p, barSec });
      if (this.chunks.length > 64) this.chunks.splice(0, this.chunks.length - 64);
      this.nextTime += dur;
      this.nextPos = e;
      if (project.loopOn && p < project.loopEnd - EPS && e >= project.loopEnd - EPS) this.nextPos = project.loopStart;
    }
  }

  async preview(loopId: string, bpm: number, semis: number) {
    const ctx = this.ensureCtx();
    this.stopPreview();
    const token = {};
    this.previewToken = token;
    const buf = await this.getBuffer(loopId, bpm, semis);
    if (this.previewToken !== token) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.previewGain);
    src.start();
    this.previewSrc = src;
  }
  private previewToken: object | null = null;

  stopPreview() {
    this.previewToken = null;
    try {
      this.previewSrc?.stop();
    } catch {}
    this.previewSrc = null;
  }

  private peak(a: AnalyserNode) {
    if (this.scratch.length !== a.fftSize) this.scratch = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.scratch);
    let m = 0;
    for (let i = 0; i < this.scratch.length; i++) m = Math.max(m, Math.abs(this.scratch[i]));
    return m;
  }

  levels() {
    if (!this.ctx) return null;
    const tracks: Record<string, number> = {};
    for (const [id, n] of this.nodes) tracks[id] = this.peak(n.meter);
    return {
      left: this.peak(this.meterL),
      right: this.peak(this.meterR),
      preview: this.previewSrc ? this.peak(this.previewMeter) : 0,
      tracks,
    };
  }

  async renderMix(project: Project, masterVol: number): Promise<Blob> {
    const barSec = barSeconds(project.bpm);
    const bars = songEnd(project);
    const len = Math.max(1, Math.ceil(bars * barSec * SR));
    await this.prepare(project);
    const ctx = new OfflineAudioContext(2, len, SR);
    const master = ctx.createGain();
    master.gain.value = masterVol;
    master.connect(ctx.destination);
    const anySolo = project.tracks.some((t) => t.solo);
    for (const t of project.tracks) {
      if (t.mute || (anySolo && !t.solo)) continue;
      const buf = this.ready.get(this.keyFor(t, project));
      if (!buf) continue;
      const g = ctx.createGain();
      g.gain.value = t.volume;
      const p = ctx.createStereoPanner();
      p.pan.value = t.pan;
      g.connect(p).connect(master);
      const loopBars = this.loops[t.loopId].bars;
      for (const ev of t.events) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(g);
        // `%` keeps the sign of the dividend. Extending a clip past the loop
        // start stores a negative offset, which AudioBufferSource rejects.
        const phase = ((ev.offset % loopBars) + loopBars) % loopBars;
        src.start(ev.start * barSec, phase * barSec);
        src.stop((ev.start + ev.len) * barSec);
      }
    }
    return encodeWav(await ctx.startRendering());
  }
}

function encodeWav(buf: AudioBuffer) {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + len * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: "audio/wav" });
}
