#!/usr/bin/env python3
"""Export native layouts, approved PNGs, and local WAVs for offline HTML.

Uses only the standard library. Reads the precomposed music; never changes assets.
"""
import argparse
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import struct
import wave

from compose_music import TRACKS, validate_theme

ROOT = Path(__file__).resolve().parents[1]
HEIGHTS = {
    **dict.fromkeys(('player_idle', 'player_run1', 'player_run2', 'player_jump', 'player_hurt'), 32),
    **dict.fromkeys(('enemy_walker1', 'enemy_walker2', 'enemy_shell1', 'enemy_shell2'), 28),
    'coin1': 20, 'coin2': 20, 'powerup': 24, 'flag': 80,
    'checkpoint': 64, 'pipe': 64, 'spike': 24,
}
TILES = {'ground_grass', 'ground_dirt', 'ground_stone', 'platform', 'bonus_block', 'used_block'}
BACKDROPS = {'backdrop_grassland', 'backdrop_underground', 'backdrop_castle'}
SOUNDS = ('jump', 'coin', 'stomp', 'damage', 'powerup', 'grow', 'checkpoint', 'gameover', 'victory')


class ExportError(ValueError):
    """A required source is absent or invalid; never substitute fallback assets."""


def read_required(path):
    if not path.is_file():
        raise ExportError(f'Missing required input: {path}')
    return path.read_bytes()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def data_uri(mime, data):
    return f'data:{mime};base64,' + base64.b64encode(data).decode('ascii')


def json_text(data):
    return json.dumps(data, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False)


def local_input(root, relative):
    if not isinstance(relative, str) or Path(relative).is_absolute():
        raise ExportError('Expected a project-relative asset path')
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ExportError(f'Asset path must stay inside the project: {relative}')
    return read_required(path)


def image_anchor(metadata, name):
    entry = metadata.get(name)
    anchor = entry.get('anchor') if isinstance(entry, dict) else None
    if not isinstance(anchor, list) or len(anchor) != 2 or any(
        isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in anchor
    ):
        raise ExportError(f'{name}: missing or invalid manifest anchor')
    return anchor


def image_asset(root, name, relative, metadata):
    raw = local_input(root, relative)
    if Path(relative).suffix.lower() != '.png' or len(raw) < 24 or raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[12:16] != b'IHDR':
        raise ExportError(f'{name}: expected a PNG with an IHDR chunk')
    width, height = struct.unpack('>II', raw[16:24])
    if not width or not height:
        raise ExportError(f'{name}: PNG dimensions must be positive')
    anchor = image_anchor(metadata, name)
    if name in BACKDROPS:
        if (width, height) != (480, 360):
            raise ExportError(f'{name}: expected 480x360 backdrop')
        draw_width, draw_height = 480, 360
    elif name in HEIGHTS:
        draw_width, draw_height = None, HEIGHTS[name]
    elif name in TILES:
        if width != height:
            raise ExportError(f'{name}: expected a square tile')
        draw_width, draw_height = 32, None
    else:
        raise ExportError(f'{name}: no approved drawing scale; add an explicit scale before exporting')
    asset = dict(src=data_uri('image/png', raw), width=width, height=height,
                 anchor=anchor, drawHeight=draw_height, drawWidth=draw_width)
    return asset, dict(path=relative, sha256=sha256(raw))


def export_images(root, manifest):
    missing = (set(HEIGHTS) | TILES | BACKDROPS) - manifest['images'].keys()
    if missing:
        raise ExportError('Missing required manifest images: ' + ', '.join(sorted(missing)))
    metadata = manifest.get('metadata')
    if not isinstance(metadata, dict):
        raise ExportError('Missing manifest anchor metadata')
    images, sources = {}, {}
    for name, relative in manifest['images'].items():
        images[name], sources[name] = image_asset(root, name, relative, metadata)
    return images, sources


def export_sounds(root, manifest):
    if manifest['version'] != 1 or set(manifest['sounds']) != set(SOUNDS):
        raise ExportError('Expected exactly nine native effects in the sound manifest')
    sounds, sources = {}, {}
    for name, sound in manifest['sounds'].items():
        raw = local_input(root, sound['path'])
        if sha256(raw) != sound['sha256']:
            raise ExportError(f'{name}: sound hash mismatch')
        with wave.open(io.BytesIO(raw), 'rb') as wav:
            if (wav.getnchannels() != 1 or wav.getsampwidth() != 2
                    or wav.getframerate() != sound['sampleRate'] or wav.getnframes() != sound['samples']
                    or len(wav.readframes(wav.getnframes())) != sound['samples'] * 2):
                raise ExportError(f'{name}: invalid effect WAV')
        sounds[name] = dict(src=data_uri('audio/wav', raw), sha256=sha256(raw))
        sources[name] = dict(path=sound['path'], sha256=sha256(raw))
    return sounds, sources


def export_music(root):
    tracks = {}
    generator_raw = read_required(root / 'scripts/compose_music.py')
    for theme, (score_path, wav_path, meta_path) in TRACKS.items():
        music_raw = read_required(root / wav_path)
        music = json.loads(read_required(root / meta_path))
        score_raw = read_required(root / score_path)
        score = json.loads(score_raw)
        profile = validate_theme(score, theme)
        if (sha256(music_raw) != music['sha256']
                or sha256(score_raw) != music['provenance']['scoreSha256']
                or sha256(generator_raw) != music['provenance']['generatorSha256']):
            raise ExportError(f'Stale music asset ({theme}): run npm run build')
        for key, value in dict(theme=theme, title=score['title'], timbreProfile=profile,
                               tempo=score['tempo'], bars=8, beatsPerBar=4, channels=1,
                               sampleRate=score['sampleRate']).items():
            if music.get(key) != value:
                raise ExportError(f'Invalid music metadata ({theme}): {key}')
        if (music['provenance']['score'] != score_path or
                music['provenance']['generator'] != 'scripts/compose_music.py' or
                music['provenance']['license'] != score['license'] or
                music['provenance']['description'] != score['provenance']):
            raise ExportError(f'Invalid music provenance ({theme})')
        with wave.open(io.BytesIO(music_raw), 'rb') as wav:
            if (wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != music['sampleRate']
                    or wav.getnframes() != music['samples'] or music['loopStart'] != 0
                    or music['samples'] != round(32 * 60 / score['tempo'] * score['sampleRate'])
                    or music['loopEnd'] != music['duration']
                    or music['duration'] != wav.getnframes() / wav.getframerate()
                    or len(wav.readframes(wav.getnframes())) != music['samples'] * 2):
                raise ExportError(f'Invalid music WAV or loop points ({theme})')
        music['src'] = data_uri('audio/wav', music_raw)
        tracks[theme] = music
    return dict(defaultTheme='grassland', tracks=tracks)


def native_levels(raw):
    levels = json.loads(raw)
    if not isinstance(levels, list) or [level['theme'] for level in levels] != list(TRACKS):
        raise ExportError('Expected three native levels in scene order')
    for level in levels:
        for key in ('geometry', 'tiles', 'coins', 'enemies', 'powers', 'spikes'):
            if not isinstance(level[key], list):
                raise ExportError(f'Invalid native level collection: {key}')
        for tile in level['tiles']:
            if not isinstance(tile['geom'], int) or not 1 <= tile['geom'] <= len(level['geometry']):
                raise ExportError('Tile geometry references must use one-based indices')
    return levels


def export_data(root=ROOT):
    """Read sources only. Return a fresh, JSON-compatible version-1 data object."""
    root = Path(root).resolve()
    source_bytes = {path: read_required(root / path) for path in
                    ('assets/levels.json', 'assets/manifest.json', 'assets/sounds/manifest.json')}
    levels = native_levels(source_bytes['assets/levels.json'])
    images, image_sources = export_images(root, json.loads(source_bytes['assets/manifest.json']))
    sounds, sound_sources = export_sounds(root, json.loads(source_bytes['assets/sounds/manifest.json']))
    return dict(
        version=1, viewport=dict(width=480, height=360), levels=levels, images=images, sounds=sounds,
        music=export_music(root),
        provenance=dict(
            sources={path: sha256(raw) for path, raw in source_bytes.items()},
            images=image_sources, sounds=sound_sources,
            coordinates=dict(x='right', y='up', geometryAnchor='left-bottom',
                             tileAnchor='center-bottom', groundTop=-112, indexBase=1),
            player=dict(normalDrawHeight=32, grownDrawHeight=48,
                        normalCollisionHeight=28, grownCollisionHeight=42,
                        normalHalfWidth=10, grownHalfWidth=14),
        ),
    )


def write_export(root=ROOT, data=None):
    root = Path(root)
    if data is None:
        data = export_data(root)
    output = root / 'web/game-data.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json_text(data) + '\n', encoding='utf-8')
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        output = write_export()
    except (OSError, ValueError, KeyError, TypeError, wave.Error) as exc:
        parser.exit(1, f'Export failed: {exc}\n')
    print(f'Exported {output}')


if __name__ == '__main__':
    main()
