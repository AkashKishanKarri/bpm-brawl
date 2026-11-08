# BPM Brawl

You don't fight. Your song does.

Each player picks a real song, and their fighter throws a hit on every beat it hears. The heavier the song (bass, loudness, punch), the harder it hits. Five 20-second rounds, or a knockout.

- 2 players or vs CPU, with player names
- Hit list with Telugu, Bollywood and Punjabi tracks, plus search for any song (iTunes 30-second previews)
- Both songs play at once: player 1 in the left ear, player 2 in the right, so play with earbuds
- Save the match's mix at the end
- 3D concert stage with React Three Fiber: LED wall, moving-head beams, lasers on drops, neon floor
- Post-processing: bloom, shockwaves on drops and knockouts, chromatic aberration on hits, scanlines, grain
- Full screen with F; quality drops automatically on slower machines; falls back to a 2D stage without WebGL
- The original single-file version is still at `/classic.html`

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

## How it's put together

- `src/game/engine.js`: audio, beat and mass analysis, song library, combat, and the 2D fighter layer
- `src/stage/`: the 3D stage (Three.js scene graph plus React Three Fiber and post-processing)
- `src/ui/Screens.jsx`: title, song picker, VS, results, pause, as React components
- The engine owns the clock and calls R3F's `advance()` each frame, so the 2D fighters and 3D stage stay in sync
