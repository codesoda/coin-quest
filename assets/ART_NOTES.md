# Coin Quest artwork

## Source record

The supplied pixel artwork is original generated art, not copied Nintendo artwork.
The original source bytes are preserved under descriptive project-relative names:

| Source | Pixels | Content |
| --- | --- | --- |
| `assets/source/characters.png` | 1254 × 1254 RGBA | Player poses, beetles, snails, coins, growth acorn, banners, and spare items. |
| `assets/source/terrain.png` | 1254 × 1254 RGBA | Grass, dirt, stone, platform, pipe, white-star blocks, spikes, and spare terrain. |
| `assets/source/backgrounds.png` | 836 × 1881 RGB | Grassland, underground, and castle panels. |

The asset manifest preserves source dimensions and SHA-256 checksums. Renaming did not change any image bytes.
No generation API is needed or called by this project.

## Processing

Run `python3 scripts/prepare_assets.py`. Pillow 11.3.0 was used for the validated build.

- Inspect the actual pixels rather than trusting reported sizes.
- Round fractional column boundaries: 0, 314, 627, 940, 1254.
- Use inspected character row gutters: 0, 340, 640, 900, 1254. Player feet extend below the nominal first row. The goal flag starts above the nominal fourth row.
- For transparent objects, set alpha below 128 to zero and the remaining alpha to 255. Remove disconnected components smaller than 100 pixels. Trim to the remaining alpha bounds. This removes faint colored edge debris while retaining the generated art.
- Paste all five player poses on a shared 249×270 transparent canvas. Center them horizontally and align their lowest opaque pixels to the bottom. All anchors are `(124.5, 270)`. The builder scales the shared canvas to 32 logical pixels tall, or 48 when grown. Idle/run/jump keep their feet on the same baseline.
- The two supplied strides look similar. Mirror only the lower 36% of `player_run2` locally to alternate the legs. Keep its generated face and torso. No new artwork is generated.
- Crop opaque square tile interiors, excluding transparent cell padding and the outer bevel. Set their alpha to 255 and resize to 32×32 with nearest-neighbor sampling. This makes adjacent collision surfaces flat and gap-free.
- Keep all three spike tips in one 32×24 image to match the 32-pixel-wide hazard.
- Crop background panels at Y boundaries 0, 627, 1254, 1881. Each panel is exactly 836×627. Resize each to 480×360 with nearest-neighbor sampling.
- Use bottom-center anchors for objects. Use center anchors for backdrops. All resizing in the preparation script uses nearest-neighbor sampling.

Tile crop boxes are Pillow `(left, top, right, bottom)` coordinates:

| Tile | Source box |
| --- | --- |
| `ground_grass` | `(61, 83, 253, 275)` |
| `ground_dirt` | `(374, 84, 566, 276)` |
| `ground_stone` | `(686, 84, 878, 276)` |
| `platform` | `(1000, 84, 1192, 276)` |
| `bonus_block` | `(378, 376, 562, 560)` |
| `used_block` | `(690, 376, 874, 560)` |

## Asset mapping

Rows and columns below are one-based. Sprite paths follow `assets/sprites/<key>.png`. Backdrop paths follow `assets/backdrops/<key>.png`. Every manifest `images` value is a project-relative path string.

| Manifest key | Source cell/panel | Output pixels | Logical height |
| --- | --- | --- | --- |
| `player_idle` | Character R1 C1 | 249×270 | 32 |
| `player_run1` | Character R1 C2 | 249×270 | 32 |
| `player_run2` | Character R1 C3, local leg edit | 249×270 | 32 |
| `player_jump` | Character R1 C4 | 249×270 | 32 |
| `player_hurt` | Character R2 C1 | 249×270 | 32 |
| `enemy_walker1` | Character R2 C2, beetle | 229×173 | 28 |
| `enemy_walker2` | Character R2 C3, beetle | 237×173 | 28 |
| `enemy_shell1` | Character R2 C4, snail | 244×174 | 28 |
| `enemy_shell2` | Character R3 C1, snail | 238×167 | 28 |
| `coin1` | Character R3 C2 | 173×179 | 20 |
| `coin2` | Character R3 C3 | 43×183 | 20 |
| `powerup` | Character R3 C4, acorn | 159×206 | 24 |
| `flag` | Character R4 C1 | 134×298 | 80 |
| `checkpoint` | Character R4 C2 | 127×218 | 64 |
| `ground_grass` | World R1 C1 | 32×32 | 32 |
| `ground_dirt` | World R1 C2 | 32×32 | 32 |
| `ground_stone` | World R1 C3 | 32×32 | 32 |
| `platform` | World R1 C4 | 32×32 | 32 |
| `pipe` | World R2 C1 | 188×229 | 64 |
| `bonus_block` | World R2 C2, white star | 32×32 | 32 |
| `used_block` | World R2 C3 | 32×32 | 32 |
| `spike` | World R2 C4 | 32×24 | 24 |
| `backdrop_grassland` | Background top | 480×360 | 360 |
| `backdrop_underground` | Background middle | 480×360 | 360 |
| `backdrop_castle` | Background bottom | 480×360 | 360 |

The pipe is available as a sprite but is not placed in these layouts. Other unused cells remain in the source sheets.
The browser draws PNGs on Canvas2D and builds menus with text-only DOM nodes. No new art is generated during a build.

## Integrity

`assets/native-integrity.json` records hashes for all 25 approved PNGs, nine effects, and three music WAVs.
`assets/manifest.json` records source-image hashes and dimensions. The native export and browser tests verify these bytes.
Normal builds do not reprocess sprites. The optional preparation script needs Pillow 11.3.0.
