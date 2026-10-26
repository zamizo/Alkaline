// Loop library. Every loop is a short pattern of notes rendered offline by the
// synth engine, so it follows the project tempo and key the way ACID loops did.

export type Instrument =
  | "drums"
  | "acid"
  | "sub"
  | "bass"
  | "pad"
  | "pluck"
  | "arp"
  | "piano"
  | "stab"
  | "riser"
  | "vinyl"
  | "downer"
  | "revcym";

export type Category = "Drums" | "Bass" | "Synths" | "Pads" | "Keys" | "FX" | "Imported";

// s = 16th-note step, n = MIDI note (drum id for drums), l = length in steps, v = velocity 0..1
export type Note = { s: number; n: number; l: number; v: number };

export type Loop = {
  id: string;
  name: string;
  category: Category;
  instrument: Instrument;
  bars: number;
  pitched: boolean;
  gain: number;
  notes: Note[];
  // Imported audio: raw samples at 44.1 kHz plus the tempo they were played at
  source?: { channels: Float32Array[]; bpm: number };
};

export const DRUM = {
  kick: 36,
  rim: 37,
  snare: 38,
  clap: 39,
  chh: 42,
  tom: 45,
  ohh: 46,
  crash: 49,
  shaker: 70,
} as const;

const n = (s: number, note: number, l = 1, v = 0.9): Note => ({ s, n: note, l, v });

function steps(list: number[], note: number, v = 0.9, l = 1): Note[] {
  return list.map((s) => n(s, note, l, v));
}

function range(from: number, to: number, by = 1) {
  const out: number[] = [];
  for (let i = from; i < to; i += by) out.push(i);
  return out;
}

// Chords used by the "Progression" family (C minor: Cm, Ab, Eb, Bb)
const PROG = [
  { root: 36, chord: [60, 63, 67] },
  { root: 32, chord: [56, 60, 63] },
  { root: 39, chord: [58, 63, 67] },
  { root: 34, chord: [58, 62, 65] },
];

export const LOOPS: Loop[] = [
  // ---------- Drums ----------
  {
    id: "four-on-floor",
    name: "Four On Floor 01",
    category: "Drums",
    instrument: "drums",
    bars: 1,
    pitched: false,
    gain: 1,
    notes: [
      ...steps([0, 4, 8, 12], DRUM.kick, 1),
      ...steps([4, 12], DRUM.clap, 0.8),
      ...steps([2, 6, 10, 14], DRUM.ohh, 0.45),
      ...steps([1, 3, 5, 7, 9, 11, 13, 15], DRUM.chh, 0.25),
    ],
  },
  {
    id: "breakbeat",
    name: "Breakbeat 02",
    category: "Drums",
    instrument: "drums",
    bars: 2,
    pitched: false,
    gain: 1,
    notes: [
      ...steps([0, 2, 10, 11, 16, 18, 26], DRUM.kick, 0.95),
      ...steps([4, 12, 20, 28], DRUM.snare, 0.9),
      ...steps([7, 9, 15, 23, 25, 30, 31], DRUM.snare, 0.35),
      ...steps(range(0, 32, 2), DRUM.chh, 0.45),
    ],
  },
  {
    id: "hiphop",
    name: "Hip Hop Groove",
    category: "Drums",
    instrument: "drums",
    bars: 2,
    pitched: false,
    gain: 1,
    notes: [
      ...steps([0, 7, 10, 16, 22, 26], DRUM.kick, 1),
      ...steps([4, 12, 20, 28], DRUM.snare, 0.9),
      ...steps([31], DRUM.snare, 0.3),
      ...range(0, 32, 2).map((s) => n(s, DRUM.chh, 1, s % 4 === 0 ? 0.5 : 0.3)),
      n(14, DRUM.ohh, 1, 0.35),
    ],
  },
  {
    id: "hats-shuffle",
    name: "Hats Shuffle",
    category: "Drums",
    instrument: "drums",
    bars: 1,
    pitched: false,
    gain: 0.8,
    notes: [
      ...range(0, 16).filter((s) => s !== 14).map((s) => n(s, DRUM.chh, 1, [0.6, 0.2, 0.4, 0.25][s % 4])),
      n(14, DRUM.ohh, 1, 0.5),
      ...steps([3, 7, 11, 15], DRUM.shaker, 0.4),
    ],
  },
  {
    id: "rim-perc",
    name: "Rim & Tom Perc",
    category: "Drums",
    instrument: "drums",
    bars: 1,
    pitched: false,
    gain: 0.8,
    notes: [...steps([3, 6, 11, 14], DRUM.rim, 0.7), ...steps([9, 13], DRUM.tom, 0.6)],
  },
  {
    id: "snare-fill",
    name: "Snare Roll Fill",
    category: "Drums",
    instrument: "drums",
    bars: 1,
    pitched: false,
    gain: 1,
    notes: [
      n(0, DRUM.kick, 1, 1),
      ...steps([0, 4], DRUM.snare, 0.7),
      ...range(8, 16).map((s) => n(s, DRUM.snare, 1, 0.35 + (s - 8) * 0.08)),
      ...steps([12, 14], DRUM.tom, 0.7),
    ],
  },
  {
    id: "crash",
    name: "Crash Hit",
    category: "Drums",
    instrument: "drums",
    bars: 1,
    pitched: false,
    gain: 0.8,
    notes: [n(0, DRUM.crash, 16, 0.9), n(0, DRUM.kick, 1, 1)],
  },

  // ---------- Bass ----------
  {
    id: "acid-303",
    name: "Acid Line 303",
    category: "Bass",
    instrument: "acid",
    bars: 1,
    pitched: true,
    gain: 0.9,
    notes: [
      n(0, 36, 1, 1),
      n(1, 36, 1, 0.5),
      n(2, 48, 1, 0.9),
      n(4, 39, 2, 0.6),
      n(6, 46, 1, 1),
      n(7, 36, 1, 0.5),
      n(9, 48, 1, 0.8),
      n(10, 36, 1, 0.5),
      n(11, 43, 1, 1),
      n(12, 36, 1, 0.6),
      n(13, 39, 1, 0.9),
      n(14, 41, 2, 0.6),
    ],
  },
  {
    id: "sub-bass",
    name: "Deep Sub Bass",
    category: "Bass",
    instrument: "sub",
    bars: 2,
    pitched: true,
    gain: 1,
    notes: [n(0, 36, 14, 1), n(16, 31, 7, 1), n(24, 34, 7, 1)],
  },
  {
    id: "funky-bass",
    name: "Funky Bass 01",
    category: "Bass",
    instrument: "bass",
    bars: 1,
    pitched: true,
    gain: 0.9,
    notes: [
      n(0, 36, 2, 1),
      n(3, 36, 1, 0.7),
      n(4, 48, 1, 0.9),
      n(6, 46, 1, 0.7),
      n(8, 43, 2, 0.9),
      n(10, 36, 1, 0.7),
      n(12, 39, 1, 0.9),
      n(14, 41, 1, 0.8),
      n(15, 42, 1, 0.6),
    ],
  },
  {
    id: "bass-prog",
    name: "Bass Progression",
    category: "Bass",
    instrument: "bass",
    bars: 4,
    pitched: true,
    gain: 0.9,
    notes: PROG.flatMap(({ root }, bar) => [
      ...[0, 3, 6, 8, 11, 14].map((s) => n(bar * 16 + s, root, 2, s === 0 ? 1 : 0.75)),
      n(bar * 16 + 10, root + 12, 1, 0.8),
    ]),
  },

  // ---------- Synths ----------
  {
    id: "trance-arp",
    name: "Trance Arp Cm",
    category: "Synths",
    instrument: "arp",
    bars: 1,
    pitched: true,
    gain: 0.7,
    notes: [72, 75, 79, 84, 79, 75, 72, 75, 79, 84, 87, 84, 79, 75, 79, 84].map((note, s) =>
      n(s, note, 1, s % 4 === 0 ? 0.9 : 0.6),
    ),
  },
  {
    id: "arp-prog",
    name: "Arp Progression",
    category: "Synths",
    instrument: "arp",
    bars: 4,
    pitched: true,
    gain: 0.7,
    notes: PROG.flatMap(({ chord }, bar) =>
      range(0, 16).map((s) => {
        const tones = [...chord, chord[0] + 12];
        const note = tones[[0, 1, 2, 3, 2, 1][s % 6]] + 12;
        return n(bar * 16 + s, note, 1, s % 4 === 0 ? 0.9 : 0.55);
      }),
    ),
  },
  {
    id: "pluck-melody",
    name: "Pluck Melody",
    category: "Synths",
    instrument: "pluck",
    bars: 2,
    pitched: true,
    gain: 0.8,
    notes: [
      n(0, 72, 2),
      n(3, 75, 1),
      n(6, 79, 2),
      n(8, 77, 2),
      n(10, 75, 2),
      n(12, 72, 3),
      n(16, 70, 2),
      n(19, 72, 1),
      n(22, 75, 2),
      n(24, 79, 2),
      n(27, 82, 2),
      n(30, 79, 2),
    ],
  },
  {
    id: "chord-stabs",
    name: "Chord Stabs",
    category: "Synths",
    instrument: "stab",
    bars: 1,
    pitched: true,
    gain: 0.7,
    notes: [2, 6, 10, 13].flatMap((s) => [60, 63, 67, 72].map((note) => n(s, note, 1, 0.8))),
  },

  // ---------- Pads ----------
  {
    id: "pad-prog",
    name: "Pad Progression",
    category: "Pads",
    instrument: "pad",
    bars: 4,
    pitched: true,
    gain: 0.65,
    notes: PROG.flatMap(({ chord }, bar) => chord.map((note) => n(bar * 16, note, 16, 0.8))),
  },
  {
    id: "warm-pad",
    name: "Warm Pad Cm",
    category: "Pads",
    instrument: "pad",
    bars: 2,
    pitched: true,
    gain: 0.65,
    notes: [60, 63, 67, 72].map((note) => n(0, note, 32, 0.8)),
  },
  {
    id: "dark-pad",
    name: "Dark Pad Fm-Cm",
    category: "Pads",
    instrument: "pad",
    bars: 2,
    pitched: true,
    gain: 0.65,
    notes: [...[53, 56, 60].map((note) => n(0, note, 16, 0.8)), ...[55, 60, 63].map((note) => n(16, note, 16, 0.8))],
  },

  // ---------- Keys ----------
  {
    id: "house-piano",
    name: "House Piano",
    category: "Keys",
    instrument: "piano",
    bars: 2,
    pitched: true,
    gain: 0.75,
    notes: [
      ...[0, 3, 6, 10, 12].flatMap((s) => [60, 63, 67, 70].map((note) => n(s, note, 2, 0.75))),
      ...[16, 19, 22, 26, 28].flatMap((s) => [56, 60, 63, 67].map((note) => n(s, note, 2, 0.75))),
    ],
  },
  {
    id: "rhodes-keys",
    name: "Lazy Keys",
    category: "Keys",
    instrument: "piano",
    bars: 2,
    pitched: true,
    gain: 0.75,
    notes: [
      ...[48, 58, 63, 67].map((note) => n(0, note, 12, 0.6)),
      ...[51, 60, 63, 70].map((note) => n(14, note, 2, 0.5)),
      ...[44, 56, 60, 63].map((note) => n(16, note, 14, 0.6)),
    ],
  },

  // ---------- FX ----------
  {
    id: "riser",
    name: "Noise Riser",
    category: "FX",
    instrument: "riser",
    bars: 4,
    pitched: false,
    gain: 0.7,
    notes: [n(0, 60, 64, 1)],
  },
  {
    id: "downlifter",
    name: "Downlifter",
    category: "FX",
    instrument: "downer",
    bars: 2,
    pitched: false,
    gain: 0.7,
    notes: [n(0, 60, 32, 1)],
  },
  {
    id: "rev-cymbal",
    name: "Reverse Cymbal",
    category: "FX",
    instrument: "revcym",
    bars: 1,
    pitched: false,
    gain: 0.7,
    notes: [n(0, 60, 16, 1)],
  },
  {
    id: "vinyl",
    name: "Vinyl Crackle",
    category: "FX",
    instrument: "vinyl",
    bars: 1,
    pitched: false,
    gain: 0.5,
    notes: [n(0, 60, 16, 1)],
  },
];

export const LOOP_BY_ID = Object.fromEntries(LOOPS.map((l) => [l.id, l])) as Record<string, Loop>;

export const CATEGORIES: Category[] = ["Drums", "Bass", "Synths", "Pads", "Keys", "FX", "Imported"];

export const CATEGORY_COLOR: Record<Category, string> = {
  Drums: "#c8553d",
  Bass: "#3d6bc8",
  Synths: "#3d9a5a",
  Pads: "#7d5cc0",
  Keys: "#b8902a",
  FX: "#2e9aa0",
  Imported: "#a8487c",
};

export const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
