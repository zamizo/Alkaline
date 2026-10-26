# Alkaline

A loop-based music workstation in the spirit of Sonic Foundry / Sony ACID, running in the browser.

- Every track follows the project tempo (time-stretch) and key (repitch) together, with per-track pitch on top
- Import your own WAV/MP3 loops — they are time-stretched with WSOLA
- Draw / select / erase tools, loop region, mixer, WAV mixdown

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Code

- `app/engine.ts` — synth voices, time-stretch / pitch-shift, transport scheduler, WAV export
- `app/page.tsx` — the UI
- `app/loops.ts` — built-in loop library
- `app/alkaline.css` — Windows 2000-era styling
