# Coin Quest

Collect coins, stomp enemies, and cross three pixel-art lands: Grassland, Underground, and Castle.
The game includes original artwork, nine sound effects, and three original scene soundtracks.
It runs offline in a browser. No account, server, or network connection is needed to play.

## Play and build

Use Node.js 24 and Python 3.12 or newer. Python build tools use only the standard library.

```sh
npm ci
npm run build
```

Open `index.html` in a browser. The build also writes the same standalone file to `dist/index.html`.
Both outputs are generated and stay out of source control. The page embeds all scripts, styles, images, and audio.

## Controls

- **← / →** or **A / D**: move.
- **Space / ↑**: jump. Hold for height; tap for a short hop.
- **Enter**: start or resume.
- **P / Esc**: pause. **I**: instructions. **M**: mute music and effects.
- **R**: restart all three levels.
- On touch screens, use the move and jump buttons.

White-star blocks release coins or growth acorns. Pennants save your place. You start with three lives.
Sound starts after an input. Focus loss pauses play; returning to the page does not restart audio by itself.

## Development checks

```sh
npx --no-install playwright install chromium --with-deps
npm run build
npm test
npm run scan
```

Tests check native layouts, asset hashes, deterministic builds, music, physics, offline browser play, audio, and touch controls.
The browser tests use the generated `index.html` with real clocks. Build before testing.

AISLOP is pinned to **0.16.1**. Its recognized `.aislop/config.yml` sets `ci.failBelow: 95`.
`npm run scan` runs `aislop ci`, rejects unscored or incomplete engine results, and requires a clean `npm audit`.
Generated assets and local evidence are excluded; authored game code and tests are not excluded.
Reports stay in ignored `tests/artifacts/quality/`.

`assets/levels.json` owns the three layouts. `assets/manifest.json` owns PNG paths and anchors.
`assets/sounds/manifest.json` records effect paths and hashes. `assets/native-integrity.json` preserves the approved asset checksums.
Edit `web/` for browser code. Classic scripts load in data, core, UI, audio, and main order without imports or fetches.
Music scores and credits live in `web/assets/`; `scripts/compose_music.py` renders them deterministically.

The optional `scripts/prepare_assets.py` pipeline uses Pillow 11.3.0. Normal builds never reprocess the approved PNGs.
See [artwork notes](assets/ART_NOTES.md) for source and processing details.

## GitHub Pages

The intended public repository is `codesoda/coin-quest`.
The intended site is <https://codesoda.github.io/coin-quest/>.
The embedded page works under this subpath and directly from `file://`.

The prepared workflow checks pull requests without deploying them. Successful `main` pushes and manual runs on `main`
can deploy only after build, tests, AISLOP, and audit pass. Only `dist/` enters the Pages artifact.
Select **GitHub Actions** as the Pages source when the repository is created.
No repository creation, push, or deployment is part of this local setup.

## Credits and license

Original code is under the [MIT license](LICENSE). No third-party runtime code is vendored in the game.
The supplied pixel artwork is original generated art, not copied Nintendo art.
The original effects and scores—*Funky Fanfare*, *Lantern Grotto*, and *Velvet Battlements*—are released under CC0-1.0.
Build and test dependencies keep their own licenses. No image or music service is used by the build.
