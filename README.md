# BPM Brawl

You don't fight. Your song does.

Each player picks a real song, and their fighter throws a hit on every beat it hears. The heavier the song (bass, loudness, punch), the harder it hits. Five 20-second rounds, or a knockout.

- 2 players or vs CPU, with player names
- Hit list with Telugu, Bollywood and Punjabi tracks, plus search for any song (iTunes 30-second previews)
- Both songs play at once: player 1 in the left ear, player 2 in the right, so play with earbuds
- Save the round's mix at the end of a match
- Real-time 3D stage (Three.js): LED wall, moving-head beams, lasers on drops, neon floor, bloom. Falls back to 2D if WebGL is unavailable
- Full screen with F, and quality drops automatically on slower machines

## Play

It's one file with no build step. Open `index.html` in Chrome, or serve the folder:

```sh
python3 -m http.server 5190
```

then go to http://localhost:5190.
