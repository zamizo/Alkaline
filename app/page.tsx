"use client";

import "./alkaline.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import { CATEGORIES, CATEGORY_COLOR, KEYS, LOOP_BY_ID, type Category, type Loop } from "./loops";
import {
  Engine,
  barSeconds,
  decodeLoopFile,
  keyShift,
  semitonesFor,
  songEnd,
  type Clip,
  type Project,
  type Track,
} from "./engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let uidCounter = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

const ROW_H = 58;
const HEADER_W = 312;
const TOP_H = 44;

type Tool = "draw" | "select" | "erase";

const makeClip = (start: number, len: number, offset = 0): Clip => ({ id: uid("c"), start, len, offset });

const makeTrack = (loop: Loop, events: Clip[] = []): Track => ({
  id: uid("t"),
  loopId: loop.id,
  name: loop.name,
  volume: 0.8,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  events,
});

function demoProject(): Project {
  // Stable ids so the server-rendered HTML matches the client
  let n = 0;
  const t = (loopId: string, ranges: [number, number][], extra: Partial<Track> = {}): Track => ({
    ...makeTrack(LOOP_BY_ID[loopId], ranges.map(([s, l]) => ({ id: `demo-c${n++}`, start: s, len: l, offset: 0 }))),
    id: `demo-t${n++}`,
    ...extra,
  });
  return {
    bpm: 128,
    key: 0,
    loopOn: true,
    loopStart: 0,
    loopEnd: 16,
    tracks: [
      t("four-on-floor", [[4, 12]]),
      t("hats-shuffle", [[8, 8]], { volume: 0.6 }),
      t("snare-fill", [[3, 1], [15, 1]], { volume: 0.7 }),
      t("crash", [[4, 1], [12, 1]], { volume: 0.5 }),
      t("bass-prog", [[4, 12]], { volume: 0.85 }),
      t("pad-prog", [[0, 16]], { volume: 0.6 }),
      t("arp-prog", [[8, 8]], { volume: 0.5, pan: 0.3 }),
      t("acid-303", [[12, 4]], { volume: 0.45, pan: -0.25 }),
      t("riser", [[0, 4], [12, 4]], { volume: 0.45 }),
    ],
  };
}

const emptyProject = (): Project => ({ bpm: 120, key: 0, loopOn: false, loopStart: 0, loopEnd: 4, tracks: [] });

// Put `c` on the track, trimming or splitting whatever it overlaps.
// Split pieces keep their loop phase through `offset`.
function placeClip(events: Clip[], c: Clip): Clip[] {
  const out: Clip[] = [];
  const cEnd = c.start + c.len;
  for (const o of events) {
    if (o.id === c.id) continue;
    const oEnd = o.start + o.len;
    if (oEnd <= c.start || o.start >= cEnd) {
      out.push(o);
      continue;
    }
    if (o.start < c.start) out.push({ ...o, len: c.start - o.start });
    if (oEnd > cEnd) out.push({ ...o, id: uid("c"), start: cEnd, len: oEnd - cEnd, offset: o.offset + (cEnd - o.start) });
  }
  out.push(c);
  return out.sort((a, b) => a.start - b.start);
}

function tint(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c * (1 - amt));
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

const peakCache = new WeakMap<AudioBuffer, Float32Array>();
function peaksOf(buf: AudioBuffer) {
  let p = peakCache.get(buf);
  if (p) return p;
  const bins = 800;
  p = new Float32Array(bins);
  const a = buf.getChannelData(0);
  const b = buf.getChannelData(1);
  const per = a.length / bins;
  let max = 1e-6;
  for (let i = 0; i < bins; i++) {
    let m = 0;
    const end = Math.min(a.length, Math.floor((i + 1) * per));
    for (let j = Math.floor(i * per); j < end; j += 4) m = Math.max(m, Math.abs(a[j]), Math.abs(b[j]));
    p[i] = m;
    max = Math.max(max, m);
  }
  for (let i = 0; i < bins; i++) p[i] /= max;
  peakCache.set(buf, p);
  return p;
}

function fmtBBT(p: number) {
  const bar = Math.floor(p + 1e-9) + 1;
  const beat = Math.floor((((p % 1) + 1) % 1) * 4 + 1e-9) + 1;
  const tick = Math.floor((((p * 4) % 1) + 1) % 1 * 960);
  return `${bar}.${beat}.${String(tick).padStart(3, "0")}`;
}

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

const db = (v: number) => (v <= 0.0001 ? "-Inf" : `${(20 * Math.log10(v)).toFixed(1)} dB`);
const panLabel = (p: number) => (Math.abs(p) < 0.02 ? "Center" : `${Math.round(Math.abs(p) * 100)}% ${p < 0 ? "L" : "R"}`);
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

// ---------------------------------------------------------------------------
// Icons (16px, drawn in the flat Win2k toolbar style)
// ---------------------------------------------------------------------------

const Icon = {
  New: () => (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M3 1h7l3 3v11H3z" fill="#fff" stroke="#000" />
      <path d="M10 1v3h3" fill="none" stroke="#000" />
    </svg>
  ),
  Open: () => (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M1 4h5l1 1h6v8H1z" fill="#e8c860" stroke="#806010" />
      <path d="M3 7h12l-2 6H1z" fill="#f8e090" stroke="#806010" />
    </svg>
  ),
  Save: () => (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M1 1h13l1 1v13H1z" fill="#3050a0" stroke="#102050" />
      <path d="M4 1h8v5H4z" fill="#fff" />
      <path d="M4 9h8v6H4z" fill="#c0c0c0" />
    </svg>
  ),
  Draw: () => (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M2 14l1-4 8-8 3 3-8 8z" fill="#f0d040" stroke="#000" />
      <path d="M2 14l1-4 3 3z" fill="#f0c0a0" stroke="#000" />
    </svg>
  ),
  Select: () => (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M4 1v12l3-3 2 5 2-1-2-5h4z" fill="#fff" stroke="#000" />
    </svg>
  ),
  Erase: () => (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M1 10l7-7 6 6-5 5H5z" fill="#f0a0b0" stroke="#000" />
      <path d="M1 10l4-4 6 6-2 2H5z" fill="#fff" stroke="#000" />
    </svg>
  ),
  ZoomIn: () => (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <circle cx="6.5" cy="6.5" r="5" fill="#fff" stroke="#000" />
      <path d="M10 10l5 5M4 6.5h5M6.5 4v5" stroke="#000" strokeWidth="1.5" />
    </svg>
  ),
  ZoomOut: () => (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <circle cx="6.5" cy="6.5" r="5" fill="#fff" stroke="#000" />
      <path d="M10 10l5 5M4 6.5h5" stroke="#000" strokeWidth="1.5" />
    </svg>
  ),
  Play: () => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M3 1l10 6-10 6z" fill="#000" />
    </svg>
  ),
  Pause: () => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M3 2h3v10H3zM8 2h3v10H8z" fill="#000" />
    </svg>
  ),
  Stop: () => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M2 2h10v10H2z" fill="#000" />
    </svg>
  ),
  Rec: () => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="5" fill="#c00000" />
    </svg>
  ),
  Loop: () => (
    <svg width="16" height="14" viewBox="0 0 16 14">
      <path d="M3 9V5h9" fill="none" stroke="#000" strokeWidth="1.6" />
      <path d="M11 2l3 3-3 3z" fill="#000" />
      <path d="M13 5v4H4" fill="none" stroke="#000" strokeWidth="1.6" />
      <path d="M5 6l-3 3 3 3z" fill="#000" />
    </svg>
  ),
  Start: () => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M2 2h2v10H2zM12 2v10L5 7z" fill="#000" />
    </svg>
  ),
  End: () => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M10 2h2v10h-2zM2 2v10l7-5z" fill="#000" />
    </svg>
  ),
  Wave: ({ color = "#fff" }: { color?: string }) => (
    <svg width="14" height="12" viewBox="0 0 14 12">
      <path d="M0 6h2l1-4 2 8 2-6 2 4 1-2h4" fill="none" stroke={color} strokeWidth="1.3" />
    </svg>
  ),
  Folder: ({ open }: { open?: boolean }) => (
    <svg width="16" height="14" viewBox="0 0 16 14">
      <path d="M1 2h5l1 1h7v10H1z" fill="#e8c860" stroke="#806010" />
      {open && <path d="M3 6h12l-2 7H1z" fill="#f8e090" stroke="#806010" />}
    </svg>
  ),
  Drive: () => (
    <svg width="16" height="14" viewBox="0 0 16 14">
      <path d="M1 4h14v7H1z" fill="#d0d0d0" stroke="#404040" />
      <path d="M11 8h2" stroke="#20c020" strokeWidth="2" />
    </svg>
  ),
};

// ---------------------------------------------------------------------------
// Clip view (event on the timeline, with stretched waveform and loop notches)
// ---------------------------------------------------------------------------

function ClipView({
  clip,
  loop,
  color,
  ppb,
  buf,
  selected,
}: {
  clip: Clip;
  loop: Loop;
  color: string;
  ppb: number;
  buf: AudioBuffer | undefined;
  selected: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = clip.len * ppb;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width));
    const h = ROW_H - 8 - 12;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    g.strokeStyle = shade(color, 0.35);
    g.beginPath();
    g.moveTo(0, mid + 0.5);
    g.lineTo(w, mid + 0.5);
    g.stroke();
    if (buf) {
      const peaks = peaksOf(buf);
      g.fillStyle = shade(color, 0.25);
      for (let x = 0; x < w; x++) {
        const b = x / ppb + clip.offset;
        const phase = (((b % loop.bars) + loop.bars) % loop.bars) / loop.bars;
        const v = peaks[Math.min(peaks.length - 1, Math.floor(phase * peaks.length))];
        const y = Math.max(0.5, v * (mid - 2));
        g.fillRect(x, mid - y, 1, y * 2);
      }
    }
    // Notches mark where the loop repeats
    g.fillStyle = "#000";
    g.strokeStyle = "rgba(0,0,0,0.45)";
    const first = Math.ceil(clip.offset / loop.bars) * loop.bars - clip.offset;
    for (let b = first; b < clip.len; b += loop.bars) {
      if (b <= 0.001) continue;
      const x = Math.round(b * ppb) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
      g.beginPath();
      g.moveTo(x - 4, 0);
      g.lineTo(x + 4, 0);
      g.lineTo(x, 5);
      g.fill();
    }
  }, [buf, width, ppb, clip.offset, clip.len, loop.bars, color]);

  return (
    <div
      className={`clip${selected ? " sel" : ""}`}
      style={{ left: clip.start * ppb, width, background: tint(color, 0.72), borderColor: shade(color, 0.3) }}
    >
      <div className="cname" style={{ background: color }}>
        {loop.name}
      </div>
      <canvas ref={ref} />
      <div className="handle start" title="Trim start" />
      <div className="handle end" title="Trim end" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menu bar
// ---------------------------------------------------------------------------

type MenuItem = { label: string; key?: string; action?: () => void; disabled?: boolean } | "sep";

function MenuBar({ menus }: { menus: { name: string; items: MenuItem[] }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="menubar" ref={ref}>
      {menus.map((m) => (
        <div key={m.name} className={`menu${open === m.name ? " open" : ""}`}>
          <button
            onPointerDown={() => setOpen(open === m.name ? null : m.name)}
            onPointerEnter={() => open && setOpen(m.name)}
          >
            <u>{m.name[0]}</u>
            {m.name.slice(1)}
          </button>
          {open === m.name && (
            <div className="menu-pop">
              {m.items.map((it, i) =>
                it === "sep" ? (
                  <hr key={i} />
                ) : (
                  <button
                    key={it.label}
                    disabled={it.disabled || !it.action}
                    onClick={() => {
                      setOpen(null);
                      it.action?.();
                    }}
                  >
                    <span>{it.label}</span>
                    <span>{it.key}</span>
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

// One engine per page load; React state only describes the project
const engine = new Engine();
engine.loops = { ...LOOP_BY_ID };
// Last rendered waveform per track, shown while a new tempo/key renders
const lastWave = new Map<string, AudioBuffer>();

type DragState = { kind: "paint" | "move" | "resize" | "trimStart" | "erase"; trackId: string; clip?: Clip; grab: number; origin: number };

// Grab within this many pixels of a clip edge trims that edge. On a short
// clip the two zones overlap, so the nearer edge wins.
const EDGE_PX = 7;

function clipEdge(xPx: number, clip: Clip, ppb: number): "start" | "end" | null {
  const left = clip.start * ppb;
  const right = (clip.start + clip.len) * ppb;
  const fromLeft = xPx - left;
  const fromRight = right - xPx;
  const nearLeft = fromLeft < EDGE_PX;
  const nearRight = fromRight < EDGE_PX;
  if (nearLeft && nearRight) return fromLeft <= fromRight ? "start" : "end";
  if (nearLeft) return "start";
  if (nearRight) return "end";
  return null;
}

export default function AlkalinePage() {
  const [project, setProject] = useState<Project>(demoProject);
  const [userLoops, setUserLoops] = useState<Record<string, Loop>>({});
  const [tool, setTool] = useState<Tool>("draw");
  const [ppb, setPpb] = useState(40);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selTracks, setSelTracks] = useState<string[]>([]);
  const [selClip, setSelClip] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ trackId: string; clip: Clip } | null>(null);
  const [category, setCategory] = useState<Category>("Drums");
  const [selLoopId, setSelLoopId] = useState<string>("four-on-floor");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [autoPreview, setAutoPreview] = useState(true);
  const [, setBufVersion] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [masterVol, setMasterVol] = useState(0.8);
  const [previewVol, setPreviewVol] = useState(0.8);
  const [status, setStatus] = useState("Ready");
  const [dialog, setDialog] = useState<"about" | null>(null);
  const [dropOver, setDropOver] = useState(false);

  const projectRef = useRef(project);
  const liveRef = useRef(project);
  const cursorRef = useRef(cursor);
  const playFrom = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cursorEl = useRef<HTMLDivElement>(null);
  const lcdRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);
  const meterL = useRef<HTMLElement>(null);
  const meterR = useRef<HTMLElement>(null);
  const meterP = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const ppbRef = useRef(ppb);
  const ghostRef = useRef(ghost);

  const allLoops = useMemo(() => ({ ...LOOP_BY_ID, ...userLoops }), [userLoops]);

  useLayoutEffect(() => {
    projectRef.current = project;
    cursorRef.current = cursor;
    ppbRef.current = ppb;
    ghostRef.current = ghost;
    engine.loops = allLoops;
  });

  const bars = Math.max(64, Math.ceil(songEnd(project)) + 16, project.loopEnd + 8);
  const barSec = barSeconds(project.bpm);

  // ---- engine wiring ----

  useEffect(() => {
    document.title = "Untitled - Alkaline";
    engine.getProject = () => liveRef.current;
    engine.onBuffer = () => setBufVersion((v) => v + 1);
    engine.onEnded = () => {
      setPlaying(false);
      setCursor(playFrom.current);
    };
    return () => {
      engine.stop();
      engine.stopPreview();
    };
  }, []);

  // Mix changes apply instantly; renders (tempo/key/pitch) are debounced and
  // swapped in once every track's stretched buffer is ready, so playback
  // never drops out while a new tempo or key is being rendered.
  useEffect(() => {
    engine.syncMix(project);
    const t = setTimeout(() => {
      setRendering(true);
      void engine.prepare(project).then(() => {
        if (projectRef.current !== project) return;
        liveRef.current = project;
        engine.syncMix(project);
        setRendering(false);
      });
    }, 90);
    return () => clearTimeout(t);
  }, [project]);

  useEffect(() => engine.setMaster(masterVol), [masterVol, playing]);
  useEffect(() => engine.setPreviewVolume(previewVol), [previewVol, previewId]);

  // ---- animation: cursor, LCD, meters ----

  useEffect(() => {
    let raf = 0;
    const held = new Map<Element, number>();
    const setMeter = (el: Element | null, level: number) => {
      if (!el) return;
      const pct = level > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(level) + 48) / 48)) : 0;
      const shown = Math.max(pct, (held.get(el) ?? 0) * 0.9);
      held.set(el, shown);
      (el as HTMLElement).style.height = `${(1 - shown) * 100}%`;
    };
    const frame = () => {
      const pos = engine.position() ?? cursorRef.current;
      const live = liveRef.current;
      if (cursorEl.current) cursorEl.current.style.left = `${HEADER_W + pos * ppbRef.current}px`;
      if (lcdRef.current) lcdRef.current.textContent = fmtBBT(pos);
      if (timeRef.current) timeRef.current.textContent = fmtTime(pos * barSeconds(live.bpm));
      const sc = scrollRef.current;
      if (sc && engine.playing) {
        const x = pos * ppbRef.current;
        const view = sc.clientWidth - HEADER_W;
        if (x > sc.scrollLeft + view - 30 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 30);
      }
      const lv = engine.levels();
      setMeter(meterL.current, lv?.left ?? 0);
      setMeter(meterR.current, lv?.right ?? 0);
      setMeter(meterP.current, lv?.preview ?? 0);
      rootRef.current?.querySelectorAll<HTMLElement>("[data-tmeter]").forEach((el) => {
        setMeter(el, engine.playing ? (lv?.tracks[el.dataset.tmeter!] ?? 0) : 0);
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- project edits ----

  const update = useCallback((fn: (p: Project) => Project) => setProject((p) => fn(p)), []);

  const updateTrack = useCallback(
    (id: string, patch: Partial<Track> | ((t: Track) => Partial<Track>)) =>
      update((p) => ({
        ...p,
        tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)),
      })),
    [update],
  );

  const addTrack = useCallback(
    (loop: Loop, at?: number) => {
      const len = Math.max(4, loop.bars);
      const start = at ?? Math.floor(cursorRef.current);
      const track = makeTrack(loop, [makeClip(start, len)]);
      update((p) => ({ ...p, tracks: [...p.tracks, track] }));
      setSelTracks([track.id]);
      setStatus(`Added track "${loop.name}"`);
      return track;
    },
    [update],
  );

  const removeTracks = useCallback(
    (ids: string[]) => {
      update((p) => ({ ...p, tracks: p.tracks.filter((t) => !ids.includes(t.id)) }));
      setSelTracks([]);
    },
    [update],
  );

  // Pitch the clicked track, or every selected track together when it is part of the selection
  const nudgePitch = useCallback(
    (trackId: string, delta: number | "reset") => {
      const targets = selTracks.includes(trackId) && selTracks.length > 1 ? selTracks : [trackId];
      update((p) => ({
        ...p,
        tracks: p.tracks.map((t) =>
          targets.includes(t.id)
            ? { ...t, pitch: delta === "reset" ? 0 : Math.max(-12, Math.min(12, t.pitch + delta)) }
            : t,
        ),
      }));
    },
    [selTracks, update],
  );

  const setKey = useCallback((k: number) => update((p) => ({ ...p, key: ((k % 12) + 12) % 12 })), [update]);
  const setBpm = useCallback(
    (b: number) => {
      if (!Number.isFinite(b)) return;
      update((p) => ({ ...p, bpm: Math.max(40, Math.min(240, Math.round(b * 1000) / 1000)) }));
    },
    [update],
  );

  // ---- transport ----

  const play = useCallback(() => {
    engine.stopPreview();
    setPreviewId(null);
    playFrom.current = cursorRef.current;
    engine.play(cursorRef.current);
    setPlaying(true);
  }, []);

  const pause = useCallback(() => {
    const pos = engine.position();
    engine.stop();
    setPlaying(false);
    if (pos != null) setCursor(pos);
  }, []);

  const stop = useCallback(() => {
    if (engine.playing) {
      engine.stop();
      setPlaying(false);
      setCursor(playFrom.current);
    } else {
      setCursor(0);
    }
  }, []);

  const seek = useCallback(
    (pos: number) => {
      const p = Math.max(0, pos);
      setCursor(p);
      if (engine.playing) {
        playFrom.current = p;
        engine.play(p);
      }
    },
    [],
  );

  const togglePlay = useCallback(() => (engine.playing ? stop() : play()), [play, stop]);

  // ---- explorer / preview ----

  const preview = useCallback(
    (loopId: string) => {
      const loop = allLoops[loopId];
      setPreviewId(loopId);
      void engine.preview(loopId, project.bpm, loop.pitched ? keyShift(project.key) : 0);
    },
    [allLoops, project.bpm, project.key],
  );

  const stopPreview = useCallback(() => {
    engine.stopPreview();
    setPreviewId(null);
  }, []);

  const importFiles = useCallback(
    async (files: File[], placeAt?: number) => {
      const added: Loop[] = [];
      for (const f of files) {
        if (!f.type.startsWith("audio/") && !/\.(wav|mp3|aif|aiff|ogg|flac|m4a)$/i.test(f.name)) continue;
        setStatus(`Importing ${f.name}…`);
        try {
          const { channels, bpm, bars } = await decodeLoopFile(f);
          const loop: Loop = {
            id: uid("u"),
            name: f.name.replace(/\.[^.]+$/, ""),
            category: "Imported",
            instrument: "drums",
            bars,
            pitched: false,
            gain: 1,
            notes: [],
            source: { channels, bpm },
          };
          added.push(loop);
        } catch {
          setStatus(`Could not decode ${f.name}`);
        }
      }
      if (!added.length) return;
      setUserLoops((u) => ({ ...u, ...Object.fromEntries(added.map((l) => [l.id, l])) }));
      Object.assign(engine.loops, Object.fromEntries(added.map((l) => [l.id, l])));
      setCategory("Imported");
      setSelLoopId(added[0].id);
      if (placeAt != null) added.forEach((l) => addTrack(l, placeAt));
      setStatus(`Imported ${added.length} file${added.length > 1 ? "s" : ""} — tempo guessed, adjust "Original tempo" if needed`);
    },
    [addTrack],
  );

  const updateUserLoop = useCallback(
    (id: string, patch: Partial<Loop> & { srcBpm?: number }) => {
      setUserLoops((u) => {
        const l = u[id];
        if (!l) return u;
        const { srcBpm, ...rest } = patch;
        const next: Loop = { ...l, ...rest, source: srcBpm && l.source ? { ...l.source, bpm: srcBpm } : l.source };
        engine.invalidate(id);
        return { ...u, [id]: next };
      });
      // force a re-render pass so tracks pick up the new stretch
      update((p) => ({ ...p }));
    },
    [update],
  );

  const renderWav = useCallback(async () => {
    if (!songEnd(project)) {
      setStatus("Nothing to render — add some events first");
      return;
    }
    setStatus("Rendering mixdown…");
    const blob = await engine.renderMix(project, masterVol);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "alkaline-mixdown.wav";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`Rendered ${fmtTime(songEnd(project) * barSec)} to alkaline-mixdown.wav`);
  }, [barSec, masterVol, project]);

  const newProject = useCallback(() => {
    engine.stop();
    setPlaying(false);
    setProject(emptyProject());
    setCursor(0);
    setSelTracks([]);
    setStatus("New project — drag loops from the Explorer onto the timeline");
  }, []);

  const loadDemo = useCallback(() => {
    engine.stop();
    setPlaying(false);
    setProject(demoProject());
    setCursor(0);
    setStatus("Demo project loaded");
  }, []);

  const deleteSelection = useCallback(() => {
    if (selClip) {
      update((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, events: t.events.filter((c) => c.id !== selClip) })) }));
      setSelClip(null);
    } else if (selTracks.length) {
      removeTracks(selTracks);
    }
  }, [removeTracks, selClip, selTracks, update]);

  const zoom = useCallback((f: number) => setPpb((z) => Math.max(10, Math.min(200, Math.round(z * f)))), []);

  // ---- keyboard ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) return;
      if (k === " ") {
        e.preventDefault();
        togglePlay();
      } else if (k === "enter") pause();
      else if (k === "d") setTool("draw");
      else if (k === "s") setTool("select");
      else if (k === "e") setTool("erase");
      else if (k === "l") update((p) => ({ ...p, loopOn: !p.loopOn }));
      else if (k === "home") seek(0);
      else if (k === "end") seek(songEnd(projectRef.current));
      else if (k === "=" || k === "+") zoom(1.25);
      else if (k === "-") zoom(0.8);
      else if (k === "delete" || k === "backspace") deleteSelection();
      else if (k === "arrowup" && e.shiftKey) setKey(projectRef.current.key + 1);
      else if (k === "arrowdown" && e.shiftKey) setKey(projectRef.current.key - 1);
      else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelection, pause, seek, setKey, togglePlay, update, zoom]);

  // ---- timeline pointer handling ----

  // The drag preview has to be readable on pointerup, which can arrive before
  // the layout effect copies state into ghostRef.
  const showGhost = (g: { trackId: string; clip: Clip } | null) => {
    ghostRef.current = g;
    setGhost(g);
  };

  const laneBar = (e: { clientX: number }, el: Element) => (e.clientX - el.getBoundingClientRect().left) / ppb;

  const onLaneDown = (e: RPointerEvent<HTMLDivElement>, track: Track) => {
    const b = laneBar(e, e.currentTarget);
    const under = track.events.find((c) => b >= c.start && b < c.start + c.len);
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      setSelTracks((s) => (s.includes(track.id) ? s.filter((x) => x !== track.id) : [...s, track.id]));
    } else if (!selTracks.includes(track.id) || selTracks.length > 1) {
      setSelTracks([track.id]);
    }
    if (e.button === 2) {
      if (under) updateTrack(track.id, (t) => ({ events: t.events.filter((c) => c.id !== under.id) }));
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "erase") {
      if (under) updateTrack(track.id, (t) => ({ events: t.events.filter((c) => c.id !== under.id) }));
      dragRef.current = { kind: "erase", trackId: track.id, grab: 0, origin: b };
      return;
    }
    if (under) {
      setSelClip(under.id);
      const xPx = e.clientX - e.currentTarget.getBoundingClientRect().left;
      const edge = clipEdge(xPx, under, ppb);
      const kind = edge === "start" ? "trimStart" : edge === "end" ? "resize" : "move";
      dragRef.current = { kind, trackId: track.id, clip: under, grab: b - under.start, origin: b };
      showGhost({ trackId: track.id, clip: under });
    } else if (tool === "draw") {
      const c = makeClip(Math.floor(b), 1, Math.floor(b) % allLoops[track.loopId].bars);
      setSelClip(c.id);
      dragRef.current = { kind: "paint", trackId: track.id, clip: c, grab: 0, origin: Math.floor(b) };
      showGhost({ trackId: track.id, clip: c });
    } else {
      setSelClip(null);
      seek(Math.round(b * 4) / 4);
    }
  };

  const onLaneMove = (e: RPointerEvent<HTMLDivElement>, track: Track) => {
    const d = dragRef.current;
    if (!d || d.trackId !== track.id) return;
    const b = Math.max(0, laneBar(e, e.currentTarget));
    if (d.kind === "erase") {
      const hit = track.events.find((c) => b >= c.start && b < c.start + c.len);
      if (hit) updateTrack(track.id, (t) => ({ events: t.events.filter((c) => c.id !== hit.id) }));
      return;
    }
    const c = d.clip!;
    let next: Clip = c;
    if (d.kind === "paint") {
      const s = Math.min(d.origin, Math.floor(b));
      const end = Math.max(d.origin, Math.floor(b)) + 1;
      const loopBars = allLoops[track.loopId].bars;
      next = { ...c, start: s, len: end - s, offset: s % loopBars };
    } else if (d.kind === "move") {
      next = { ...c, start: Math.max(0, Math.round(b - d.grab)) };
    } else if (d.kind === "resize") {
      next = { ...c, len: Math.max(1, Math.round(b - c.start)) };
    } else if (d.kind === "trimStart") {
      const end = c.start + c.len;
      const start = Math.min(end - 1, Math.max(0, Math.round(b)));
      const delta = start - c.start;
      next = { ...c, start, len: c.len - delta, offset: c.offset + delta };
    }
    showGhost({ trackId: track.id, clip: next });
  };

  const onLaneUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const g = ghostRef.current;
    if (g) updateTrack(g.trackId, (t) => ({ events: placeClip(t.events, g.clip) }));
    showGhost(null);
  };

  // ---- ruler / loop region ----

  const rulerDrag = useRef<{ origin: number; moved: boolean } | null>(null);

  const onLoopBarDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const b = Math.round(laneBar(e, e.currentTarget));
    rulerDrag.current = { origin: b, moved: false };
  };
  const onLoopBarMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = rulerDrag.current;
    if (!d) return;
    const b = Math.max(0, Math.round(laneBar(e, e.currentTarget)));
    if (b === d.origin && !d.moved) return;
    d.moved = true;
    const s = Math.min(d.origin, b);
    const en = Math.max(d.origin, b);
    if (en > s) update((p) => ({ ...p, loopStart: s, loopEnd: en, loopOn: true }));
  };
  const onLoopBarUp = () => {
    const d = rulerDrag.current;
    rulerDrag.current = null;
    if (d && !d.moved) update((p) => ({ ...p, loopOn: !p.loopOn }));
  };

  // ---- drag & drop from explorer / Finder ----

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes("text/alkaline-loop") || e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropOver(true);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropOver(false);
    const content = (e.currentTarget as HTMLElement).querySelector(".tl-content")!;
    const rect = content.getBoundingClientRect();
    const bar = Math.max(0, Math.floor((e.clientX - rect.left - HEADER_W) / ppb));
    const row = Math.floor((e.clientY - rect.top - TOP_H) / ROW_H);
    if (e.dataTransfer.files.length) {
      void importFiles([...e.dataTransfer.files], bar);
      return;
    }
    const loopId = e.dataTransfer.getData("text/alkaline-loop");
    const loop = allLoops[loopId];
    if (!loop) return;
    const target = project.tracks[row];
    if (target && target.loopId === loopId) {
      updateTrack(target.id, (t) => ({ events: placeClip(t.events, makeClip(bar, Math.max(1, loop.bars), bar % loop.bars)) }));
    } else {
      addTrack(loop, bar);
    }
  };

  // ---- derived ----

  const selLoop = allLoops[selLoopId];
  const loopsInCat = Object.values(allLoops).filter((l) => l.category === category);
  const anySolo = project.tracks.some((t) => t.solo);

  const menus: { name: string; items: MenuItem[] }[] = [
    {
      name: "File",
      items: [
        { label: "New", key: "", action: newProject },
        { label: "Open Demo Project", action: loadDemo },
        "sep",
        { label: "Import Audio…", action: () => fileInput.current?.click() },
        { label: "Render As WAV…", action: () => void renderWav() },
        "sep",
        { label: "Exit" },
      ],
    },
    {
      name: "Edit",
      items: [
        { label: "Undo" },
        "sep",
        { label: "Delete", key: "Del", action: deleteSelection, disabled: !selClip && !selTracks.length },
        { label: "Select All Tracks", action: () => setSelTracks(project.tracks.map((t) => t.id)) },
      ],
    },
    {
      name: "View",
      items: [
        { label: "Zoom In", key: "+", action: () => zoom(1.25) },
        { label: "Zoom Out", key: "-", action: () => zoom(0.8) },
      ],
    },
    {
      name: "Insert",
      items: [{ label: "Selected Loop as Track", action: () => selLoop && addTrack(selLoop) }],
    },
    {
      name: "Tools",
      items: [
        { label: "Draw", key: "D", action: () => setTool("draw") },
        { label: "Select", key: "S", action: () => setTool("select") },
        { label: "Erase", key: "E", action: () => setTool("erase") },
      ],
    },
    {
      name: "Options",
      items: [
        { label: "Project Key Up", key: "Shift+↑", action: () => setKey(project.key + 1) },
        { label: "Project Key Down", key: "Shift+↓", action: () => setKey(project.key - 1) },
        "sep",
        { label: "Double Tempo", action: () => setBpm(project.bpm * 2) },
        { label: "Half Tempo", action: () => setBpm(project.bpm / 2) },
        "sep",
        { label: "Reset All Track Pitches", action: () => update((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, pitch: 0 })) })) },
        { label: "Loop Playback", key: "L", action: () => update((p) => ({ ...p, loopOn: !p.loopOn })) },
      ],
    },
    { name: "Help", items: [{ label: "About Alkaline…", action: () => setDialog("about") }] },
  ];

  const laneBg = {
    width: bars * ppb,
    backgroundImage: `linear-gradient(to right, #b4b4b4 1px, transparent 1px), linear-gradient(to right, #d4d4d4 1px, transparent 1px)`,
    backgroundSize: `${ppb}px 100%, ${ppb / 4}px 100%`,
  };

  return (
    <div className="alkaline" ref={rootRef} onContextMenu={(e) => e.preventDefault()}>
      <div className="titlebar">
        <Icon.Wave />
        <span>Untitled - Alkaline</span>
        <div className="tb-ctrl">
          <span className="raised">_</span>
          <span className="raised">□</span>
          <span className="raised">×</span>
        </div>
      </div>

      <MenuBar menus={menus} />

      <div className="toolbar">
        <div className="grip" />
        <button className="tbtn" title="New project" onClick={newProject}>
          <Icon.New />
        </button>
        <button className="tbtn" title="Import audio files" onClick={() => fileInput.current?.click()}>
          <Icon.Open />
        </button>
        <button className="tbtn" title="Render as WAV" onClick={() => void renderWav()}>
          <Icon.Save />
        </button>
        <div className="sep" />
        <button className={`tbtn${tool === "draw" ? " on" : ""}`} title="Draw tool (D)" onClick={() => setTool("draw")}>
          <Icon.Draw />
        </button>
        <button className={`tbtn${tool === "select" ? " on" : ""}`} title="Select tool (S)" onClick={() => setTool("select")}>
          <Icon.Select />
        </button>
        <button className={`tbtn${tool === "erase" ? " on" : ""}`} title="Erase tool (E)" onClick={() => setTool("erase")}>
          <Icon.Erase />
        </button>
        <div className="sep" />
        <button className="tbtn" title="Zoom in (+)" onClick={() => zoom(1.25)}>
          <Icon.ZoomIn />
        </button>
        <button className="tbtn" title="Zoom out (-)" onClick={() => zoom(0.8)}>
          <Icon.ZoomOut />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          multiple
          hidden
          onChange={(e) => {
            void importFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      {/* ---------------- Timeline ---------------- */}
      <div className="main sunken">
        <div
          className={`tl-scroll${dropOver ? " drop-over" : ""}`}
          ref={scrollRef}
          onDragOver={onDragOver}
          onDragLeave={() => setDropOver(false)}
          onDrop={onDrop}
          style={{ ["--header-w" as string]: `${HEADER_W}px`, ["--row-h" as string]: `${ROW_H}px` }}
        >
          <div className="tl-content" style={{ width: HEADER_W + bars * ppb }}>
            <div className="tl-top">
              <div className="corner">
                <label title="Project tempo — every track time-stretches to follow it">
                  ♩=
                  <input
                    className="field"
                    type="number"
                    min={40}
                    max={240}
                    step={0.5}
                    style={{ width: 62 }}
                    value={project.bpm}
                    onChange={(e) => setBpm(parseFloat(e.target.value))}
                  />
                </label>
                <label title="Project key — every pitched track repitches to follow it">
                  Key
                  <select className="field" style={{ height: 18, padding: 0 }} value={project.key} onChange={(e) => setKey(+e.target.value)}>
                    {KEYS.map((k, i) => (
                      <option key={k} value={i}>
                        {k} {i ? `(${signed(keyShift(i))})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <span>4/4</span>
                <input
                  type="range"
                  min={60}
                  max={200}
                  step={1}
                  value={project.bpm}
                  onChange={(e) => setBpm(+e.target.value)}
                  style={{ gridColumn: "1 / 3", width: "100%", height: 14, margin: 0 }}
                  title="Drag to time-stretch every track together"
                />
                <span className={rendering ? "busy" : ""} style={{ fontSize: 10 }}>
                  {rendering ? "Stretching…" : "Synced"}
                </span>
              </div>
              <div className="ruler" style={{ width: bars * ppb }}>
                <div className="loopbar" onPointerDown={onLoopBarDown} onPointerMove={onLoopBarMove} onPointerUp={onLoopBarUp}>
                  <div
                    className={`loopregion${project.loopOn ? "" : " off"}`}
                    style={{ left: project.loopStart * ppb, width: (project.loopEnd - project.loopStart) * ppb }}
                  />
                </div>
                <div className="ticks" onPointerDown={(e) => seek(Math.round(laneBar(e, e.currentTarget) * 4) / 4)}>
                  {Array.from({ length: bars }, (_, i) => (
                    <div key={i}>
                      <div className="tick" style={{ left: i * ppb, height: 12 }} />
                      {ppb >= 20 &&
                        [1, 2, 3].map((q) => <div key={q} className="tick" style={{ left: i * ppb + (q * ppb) / 4, height: 4 }} />)}
                      {(ppb >= 24 || i % 4 === 0) && (
                        <div className="tick-label" style={{ left: i * ppb }}>
                          {i + 1}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {project.loopOn && (
              <div
                style={{
                  position: "absolute",
                  top: TOP_H,
                  bottom: 0,
                  left: HEADER_W + project.loopStart * ppb,
                  width: (project.loopEnd - project.loopStart) * ppb,
                  background: "rgba(232, 216, 120, 0.16)",
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
            )}

            {project.tracks.map((track, i) => {
              const loop = allLoops[track.loopId];
              const color = CATEGORY_COLOR[loop.category];
              const key = Engine.bufferKey(track.loopId, project.bpm, semitonesFor(loop, track, project));
              const ready = engine.readyBuffer(key);
              if (ready) lastWave.set(track.id, ready);
              const buf = ready ?? lastWave.get(track.id);
              const events = ghost?.trackId === track.id ? placeClip(track.events, ghost.clip) : track.events;
              const sel = selTracks.includes(track.id);
              const totalSemis = semitonesFor(loop, track, project);
              const audible = !track.mute && (!anySolo || track.solo);
              return (
                <div className="row" key={track.id}>
                  <div
                    className={`thead${sel ? " sel" : ""}`}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest("button,input")) return;
                      if (e.metaKey || e.ctrlKey || e.shiftKey)
                        setSelTracks((s) => (s.includes(track.id) ? s.filter((x) => x !== track.id) : [...s, track.id]));
                      else setSelTracks([track.id]);
                      setSelClip(null);
                    }}
                  >
                    <div className="ticon raised" style={{ background: audible ? color : "#909090" }}>
                      <span>{i + 1}</span>
                      <Icon.Wave />
                    </div>
                    <div className="tbody">
                      <div className="tline">
                        <span className="tname" title={track.name}>
                          {track.name}
                        </span>
                        <button
                          className={`btn mini mute${track.mute ? " on" : ""}`}
                          title="Mute"
                          onClick={() => updateTrack(track.id, { mute: !track.mute })}
                        >
                          M
                        </button>
                        <button
                          className={`btn mini solo${track.solo ? " on" : ""}`}
                          title="Solo"
                          onClick={() => updateTrack(track.id, { solo: !track.solo })}
                        >
                          S
                        </button>
                        <button className="btn mini" title="Delete track" onClick={() => removeTracks([track.id])}>
                          ×
                        </button>
                      </div>
                      <div className="tline">
                        <span className="lbl">Vol</span>
                        <input
                          type="range"
                          min={0}
                          max={1.5}
                          step={0.01}
                          value={track.volume}
                          style={{ width: 78 }}
                          onChange={(e) => updateTrack(track.id, { volume: +e.target.value })}
                          onDoubleClick={() => updateTrack(track.id, { volume: 1 })}
                        />
                        <span className="val">{db(track.volume)}</span>
                        <span className="lbl" style={{ marginLeft: 4 }}>
                          Pan
                        </span>
                        <input
                          type="range"
                          min={-1}
                          max={1}
                          step={0.02}
                          value={track.pan}
                          style={{ width: 54 }}
                          title={panLabel(track.pan)}
                          onChange={(e) => updateTrack(track.id, { pan: +e.target.value })}
                          onDoubleClick={() => updateTrack(track.id, { pan: 0 })}
                        />
                      </div>
                      <div className="tline">
                        <span className="lbl">Pitch</span>
                        <span className="pitch">
                          <button className="btn mini" title="Down a semitone (applies to all selected tracks)" onClick={() => nudgePitch(track.id, -1)}>
                            –
                          </button>
                          <span
                            className={`num sunken${track.pitch ? " shifted" : ""}`}
                            style={{ background: "#fff" }}
                            title="Double-click to reset"
                            onDoubleClick={() => nudgePitch(track.id, "reset")}
                          >
                            {signed(track.pitch)}
                          </span>
                          <button className="btn mini" title="Up a semitone (applies to all selected tracks)" onClick={() => nudgePitch(track.id, 1)}>
                            +
                          </button>
                        </span>
                        <span className="lbl" style={{ marginLeft: 4, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {loop.source ? `${loop.source.bpm}→${project.bpm} BPM` : `${loop.bars} bar${loop.bars > 1 ? "s" : ""}`}
                          {" · "}
                          {totalSemis ? `${signed(totalSemis)} st` : "orig pitch"}
                          {!loop.pitched && project.key !== 0 ? " (no key)" : ""}
                        </span>
                      </div>
                    </div>
                    <div className="tmeter sunken">
                      <i data-tmeter={track.id} />
                    </div>
                  </div>
                  <div
                    className={`lane ${tool}`}
                    style={{ ...laneBg, background: undefined, backgroundColor: sel ? "var(--lane-sel)" : "var(--lane)" }}
                    onPointerDown={(e) => onLaneDown(e, track)}
                    onPointerMove={(e) => onLaneMove(e, track)}
                    onPointerUp={onLaneUp}
                    onPointerCancel={onLaneUp}
                  >
                    {events.map((c) => (
                      <ClipView key={c.id} clip={c} loop={loop} color={color} ppb={ppb} buf={buf} selected={c.id === selClip} />
                    ))}
                  </div>
                </div>
              );
            })}

            <div className="dropzone">
              <div className="hint">
                {project.tracks.length ? "Drag loops here to add tracks" : "Drag a loop from the Explorer (or audio files from Finder) here to start"}
              </div>
            </div>

            <div className={`cursor${playing ? " play" : ""}`} ref={cursorEl} style={{ left: HEADER_W + cursor * ppb }} />
          </div>
        </div>
      </div>

      {/* ---------------- Transport ---------------- */}
      <div className="transport">
        <button className="btn" disabled title="Record">
          <Icon.Rec />
        </button>
        <button
          className={`btn${project.loopOn ? " on" : ""}`}
          title="Loop playback (L)"
          onClick={() => update((p) => ({ ...p, loopOn: !p.loopOn }))}
        >
          <Icon.Loop />
        </button>
        <div className="sep" />
        <button className="btn" title="Go to start (Home)" onClick={() => seek(0)}>
          <Icon.Start />
        </button>
        <button className={`btn${playing ? " on" : ""}`} title="Play (Space)" onClick={play}>
          <Icon.Play />
        </button>
        <button className="btn" title="Pause (Enter)" onClick={pause}>
          <Icon.Pause />
        </button>
        <button className="btn" title="Stop (Space)" onClick={stop}>
          <Icon.Stop />
        </button>
        <button className="btn" title="Go to end (End)" onClick={() => seek(songEnd(project))}>
          <Icon.End />
        </button>
        <div className="sep" />
        <div className="lcd sunken" ref={lcdRef}>
          1.1.000
        </div>
        <div className="lcd-small sunken" ref={timeRef}>
          00:00.000
        </div>
        <div className="info">
          <span>
            Tempo <b>{project.bpm}</b> BPM · Key <b>{KEYS[project.key]}</b> · 4/4
          </span>
        </div>
      </div>

      {/* ---------------- Docked windows ---------------- */}
      <div className="dock">
        <div className="pane explorer raised">
          <div className="pane-title">Explorer</div>
          <div className="explorer-body">
            <div className="tree sunken">
              <div>
                <Icon.Drive /> My Computer
              </div>
              <div style={{ paddingLeft: 10 }}>
                <Icon.Folder open /> Alkaline Loops
              </div>
              {CATEGORIES.map((c) => (
                <div key={c} className={`sub${c === category ? " on" : ""}`} onClick={() => setCategory(c)}>
                  <Icon.Folder open={c === category} /> {c}
                  <span style={{ opacity: 0.6 }}>({Object.values(allLoops).filter((l) => l.category === c).length})</span>
                </div>
              ))}
            </div>
            <div className="files sunken">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Length</th>
                    <th>Type</th>
                    <th>Key</th>
                    <th>Tempo</th>
                  </tr>
                </thead>
                <tbody>
                  {loopsInCat.map((l) => (
                    <tr
                      key={l.id}
                      className={`${l.id === selLoopId ? "on" : ""}${l.id === previewId ? " playing" : ""}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/alkaline-loop", l.id);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => {
                        setSelLoopId(l.id);
                        if (autoPreview) preview(l.id);
                      }}
                      onDoubleClick={() => {
                        stopPreview();
                        addTrack(l);
                      }}
                    >
                      <td>{l.name}.wav</td>
                      <td>
                        {l.bars} bar{l.bars > 1 ? "s" : ""}
                      </td>
                      <td>{l.pitched ? "Loop" : "Beat"}</td>
                      <td>{l.pitched ? "C" : "—"}</td>
                      <td>{l.source ? `${l.source.bpm}` : "any"}</td>
                    </tr>
                  ))}
                  {!loopsInCat.length && (
                    <tr>
                      <td colSpan={5} style={{ color: "#808080", padding: 8 }}>
                        No loops here. Use File › Import Audio… or drop audio files onto the timeline.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="ex-bar">
            <button className="btn" title="Preview" onClick={() => selLoop && preview(selLoop.id)}>
              <Icon.Play />
            </button>
            <button className="btn" title="Stop preview" onClick={stopPreview}>
              <Icon.Stop />
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <input type="checkbox" checked={autoPreview} onChange={(e) => setAutoPreview(e.target.checked)} />
              Auto Preview
            </label>
            <button className="btn" onClick={() => fileInput.current?.click()}>
              Import…
            </button>
            <div className="props sunken">
              {selLoop && !selLoop.source && (
                <span>
                  {selLoop.name} · {selLoop.bars} measure{selLoop.bars > 1 ? "s" : ""} · {selLoop.pitched ? "root C, follows project key" : "beat, ignores key"} · stretches to {project.bpm} BPM
                </span>
              )}
              {selLoop?.source && (
                <>
                  <span>Original tempo</span>
                  <input
                    className="field"
                    type="number"
                    step={0.01}
                    style={{ width: 66, height: 18 }}
                    value={selLoop.source.bpm}
                    onChange={(e) => +e.target.value > 20 && updateUserLoop(selLoop.id, { srcBpm: +e.target.value })}
                  />
                  <span>Bars</span>
                  <select
                    className="field"
                    style={{ height: 18, padding: 0 }}
                    value={selLoop.bars}
                    onChange={(e) => {
                      const nb = +e.target.value;
                      const secs = (selLoop.bars * 240) / selLoop.source!.bpm;
                      updateUserLoop(selLoop.id, { bars: nb, srcBpm: Math.round(((nb * 240) / secs) * 100) / 100 });
                    }}
                  >
                    {[1, 2, 4, 8, 16].map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <input
                      type="checkbox"
                      checked={selLoop.pitched}
                      onChange={(e) => updateUserLoop(selLoop.id, { pitched: e.target.checked })}
                    />
                    Follow key (root C)
                  </label>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="pane mixer raised">
          <div className="pane-title">Mixer</div>
          <div className="mixer-body">
            <div className="strip sunken">
              <b>Preview</b>
              <div className="faders">
                <input type="range" min={0} max={1.2} step={0.01} value={previewVol} onChange={(e) => setPreviewVol(+e.target.value)} />
                <div className="meter sunken">
                  <i ref={meterP} />
                </div>
              </div>
              <span>{db(previewVol)}</span>
            </div>
            <div className="strip sunken">
              <b>Master</b>
              <div className="faders">
                <input type="range" min={0} max={1.2} step={0.01} value={masterVol} onChange={(e) => setMasterVol(+e.target.value)} />
                <div className="meter sunken">
                  <i ref={meterL} />
                </div>
                <div className="meter sunken">
                  <i ref={meterR} />
                </div>
              </div>
              <span>{db(masterVol)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="statusbar">
        <div className="sunken" style={{ flex: 1 }}>
          {status}
        </div>
        <div className={`sunken${rendering ? " busy" : ""}`}>{rendering ? "Stretching / repitching…" : "Ready"}</div>
        <div className="sunken">Tracks: {project.tracks.length}</div>
        <div className="sunken">Length: {fmtTime(songEnd(project) * barSec)}</div>
        <div className="sunken">
          {project.bpm} BPM, {KEYS[project.key]}
        </div>
      </div>

      {dialog === "about" && (
        <div className="modal-bg" onPointerDown={() => setDialog(null)}>
          <div className="dialog" onPointerDown={(e) => e.stopPropagation()}>
            <div className="titlebar">
              <span>About Alkaline</span>
            </div>
            <div className="content">
              <b style={{ fontSize: 14 }}>Alkaline</b>
              <div>
                The opposite of ACID: a loop-based music workstation in the spirit of Sonic Foundry / Sony ACID. Every track follows the project tempo
                (time-stretch) and key (repitch) together; per-track pitch shifts on top. Imported audio is stretched with WSOLA.
              </div>
              <div style={{ color: "#404040" }}>
                Space play/stop · Enter pause · D/S/E tools · L loop · Shift+↑/↓ key · ⌘/Shift-click tracks to pitch several at once
                · Right-click an event to delete
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setDialog(null)}>
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
