#!/usr/bin/env python3
"""Derive game PNGs from the three preserved generated sources. No generation API."""
import hashlib
import json
from collections import deque
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/source'
CHARACTERS = SOURCE / 'characters.png'
TERRAIN = SOURCE / 'terrain.png'
BACKGROUND = SOURCE / 'backgrounds.png'
NEAREST = Image.Resampling.NEAREST


def clean(image):
    """Threshold faint matte debris and discard disconnected islands < 100 pixels."""
    image = image.convert('RGBA')
    alpha = image.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    width, height = image.size
    pixels = bytearray(alpha.tobytes())
    seen = bytearray(len(pixels))
    for start, value in enumerate(pixels):
        if not value or seen[start]:
            continue
        queue = deque([start])
        seen[start] = 1
        component = []
        while queue:
            i = queue.popleft()
            component.append(i)
            x, y = i % width, i // width
            neighbors = []
            if x: neighbors.append(i - 1)
            if x + 1 < width: neighbors.append(i + 1)
            if y: neighbors.append(i - width)
            if y + 1 < height: neighbors.append(i + width)
            for j in neighbors:
                if pixels[j] and not seen[j]:
                    seen[j] = 1
                    queue.append(j)
        if len(component) < 100:
            for i in component: pixels[i] = 0
    image.putalpha(Image.frombytes('L', image.size, bytes(pixels)))
    return image.crop(image.getbbox())


def cell(sheet, col, row, rows):
    # Rounded fractional columns avoid dropping the half-pixel at 1254 / 4.
    return clean(sheet.crop((round(col * sheet.width / 4), rows[row],
                             round((col + 1) * sheet.width / 4), rows[row + 1])))


def main():
    characters, terrain, background = map(Image.open, (CHARACTERS, TERRAIN, BACKGROUND))
    assert characters.size == terrain.size == (1254, 1254)
    assert background.size == (836, 1881)
    images, metadata = {}, {}

    def save(name, image, backdrop=False):
        folder = 'backdrops' if backdrop else 'sprites'
        rel = f'assets/{folder}/{name}.png'
        path = ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path, optimize=True)
        images[name] = rel
        metadata[name] = {'anchor': [image.width / 2, image.height / 2 if backdrop else image.height]}

    # First-row feet extend past the nominal 314 boundary. The flag starts above
    # 940. These inspected gutters retain both and avoid neighboring artwork.
    rows = [0, 340, 640, 900, 1254]
    mapping = {
        'player_idle': (0, 0), 'player_run1': (1, 0), 'player_run2': (2, 0),
        'player_jump': (3, 0), 'player_hurt': (0, 1),
        'enemy_walker1': (1, 1), 'enemy_walker2': (2, 1),
        'enemy_shell1': (3, 1), 'enemy_shell2': (0, 2),
        'coin1': (1, 2), 'coin2': (2, 2), 'powerup': (3, 2),
        'flag': (0, 3), 'checkpoint': (1, 3),
    }
    frames = {name: cell(characters, col, row, rows) for name, (col, row) in mapping.items()}
    players = [name for name in frames if name.startswith('player_')]
    width = max(frames[name].width for name in players)
    height = max(frames[name].height for name in players)
    # The generated strides are nearly identical. Reverse only run2's lower
    # trouser/boot region, keeping its face and torso intact (local pixel edit).
    run = frames['player_run2']
    split = round(run.height * .64)
    run.paste(ImageOps.mirror(run.crop((0, split, run.width, run.height))), (0, split))
    for name, image in frames.items():
        if name in players:
            canvas = Image.new('RGBA', (width, height))
            canvas.alpha_composite(image, ((width - image.width) // 2, height - image.height))
            image = canvas
        save(name, image)

    # Crop the opaque, square tile bodies, not their padded transparent cells.
    # A small outer bevel is excluded, keeping the collision top perfectly flat.
    squares = {
        'ground_grass': (61, 83, 253, 275),
        'ground_dirt': (374, 84, 566, 276),
        'ground_stone': (686, 84, 878, 276),
        'platform': (1000, 84, 1192, 276),
        'bonus_block': (378, 376, 562, 560),
        'used_block': (690, 376, 874, 560),
    }
    for name, box in squares.items():
        tile = terrain.crop(box)
        assert tile.getchannel('A').getextrema()[0] >= 128, name
        tile.putalpha(255)
        save(name, tile.resize((32, 32), NEAREST))
    save('pipe', cell(terrain, 0, 1, [0, 314, 627, 900, 1254]))
    # Three spikes share one 32px hazard; retain all three in the collision width.
    save('spike', cell(terrain, 3, 1, [0, 314, 627, 900, 1254]).resize((32, 24), NEAREST))
    for row, theme in enumerate(['grassland', 'underground', 'castle']):
        panel = background.crop((0, row * 627, 836, (row + 1) * 627))
        save('backdrop_' + theme, panel.resize((480, 360), NEAREST), True)
    sources = {str(p.relative_to(ROOT)): {'size': list(image.size),
               'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
               for p, image in zip((CHARACTERS, TERRAIN, BACKGROUND),
                                   (characters, terrain, background))}
    manifest = {'images': images, 'metadata': metadata, 'sources': sources}
    (ROOT / 'assets/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared {len(images)} PNGs; shared player canvas {width}x{height}. Sources unchanged.')


if __name__ == '__main__':
    main()
