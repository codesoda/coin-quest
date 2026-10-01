#!/usr/bin/env python3
"""Build root index.html, a self-contained file:// native game.

The template owns the <style>/<script> tags: <script>{{GAME_DATA}}</script>.
GAME_DATA expands to the full window.COIN_QUEST_DATA = <safe JSON>; declaration.
Original artwork and effect bytes are never rewritten.
"""
import argparse
from html.parser import HTMLParser
from pathlib import Path
import re

from compose_music import compose, TRACKS

from export_web_assets import ROOT, ExportError, export_data, json_text, read_required, sha256, write_export

TOKENS = ('STYLE', 'GAME_DATA', 'CORE_JS', 'UI_JS', 'AUDIO_JS', 'MAIN_JS')


def script_safe_json(data):
    # Escape every '<' (including mixed-case closing tags and HTML comments).
    # ensure_ascii also escapes U+2028/U+2029 for classic script compatibility.
    return json_text(data).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


class OfflineHTML(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'module':
            raise ExportError('Native HTML must use classic scripts, not ES modules')
        for key in ('src', 'href', 'poster', 'data', 'action', 'srcset'):
            value = attrs.get(key)
            if value and not value.startswith(('data:', '#')):
                raise ExportError(f'Native HTML requires embedded resources: {tag} {key}={value}')


def assemble_html(template, style, core, main, data, ui="", audio=""):
    for token in TOKENS:
        if template.count('{{' + token + '}}') != 1:
            raise ExportError(f'Template requires exactly one {{{{{token}}}}} placeholder')
    order = [template.index('{{' + token + '}}') for token in TOKENS[1:]]
    if order != sorted(order):
        raise ExportError('Template must declare data and core before the main script')
    for label, text, closing in (('STYLE', style, 'style'), ('CORE_JS', core, 'script'),
                                 ('UI_JS', ui, 'script'), ('AUDIO_JS', audio, 'script'), ('MAIN_JS', main, 'script')):
        if re.search(r'</' + closing + r'\b', text, re.IGNORECASE):
            raise ExportError(f'{label} contains an unsafe closing HTML tag')
    if re.search(r'@import\b', style, re.IGNORECASE):
        raise ExportError('CSS imports are not allowed in the offline build')
    for match in re.finditer(r'url\(\s*[\'\"]?([^\'\")]+)', style, re.IGNORECASE):
        if not match[1].startswith(('data:', '#')):
            raise ExportError('CSS resources must be embedded data URLs')
    replacements = dict(STYLE=style, GAME_DATA='window.COIN_QUEST_DATA = ' + script_safe_json(data) + ';',
                        CORE_JS=core, UI_JS=ui, AUDIO_JS=audio, MAIN_JS=main)
    # One substitution pass: content that happens to contain a token remains data.
    html = re.sub(r'\{\{(STYLE|GAME_DATA|CORE_JS|UI_JS|AUDIO_JS|MAIN_JS)\}\}', lambda m: replacements[m[1]], template)
    OfflineHTML().feed(html)
    return html


def build(root=ROOT):
    root = Path(root).resolve()
    paths = dict(template='web/template.html', style='web/style.css', core='web/core.js',
                 ui='web/ui.js', audio='web/audio.js', main='web/main.js')
    inputs = {name: read_required(root / path) for name, path in paths.items()}
    for name, content in inputs.items():
        if not content.strip():
            raise ExportError(f'Empty required input: {root / paths[name]}')
    # Require the score/generator, but generate WAV/metadata when absent or stale.
    for relative in ('scripts/compose_music.py', *(paths[0] for paths in TRACKS.values())):
        read_required(root / relative)
    compose(root)
    data = export_data(root)
    if any(not data['music']['tracks'][theme]['src'].startswith('data:audio/wav;base64,') for theme in TRACKS):
        raise ExportError('Final HTML requires embedded music')
    html = assemble_html(**{name: content.decode('utf-8') for name, content in inputs.items()}, data=data)
    sources = {paths[name]: sha256(content) for name, content in inputs.items()}
    for relative in ('scripts/build_web.py', 'scripts/export_web_assets.py', 'scripts/compose_music.py', *(path for paths in TRACKS.values() for path in paths)):
        sources[relative] = sha256(read_required(root / relative))
    # No absolute paths or build timestamps: equal sources yield equal output bytes.
    html = '<!-- Native build source SHA-256: ' + json_text(sources) + ' -->\n' + html
    write_export(root, data)
    output = root / 'index.html'
    output.write_text(html, encoding='utf-8')
    dist = root / 'dist'
    dist.mkdir(exist_ok=True)
    (dist / 'index.html').write_bytes(output.read_bytes())
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        output = build()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f'Build failed: {exc}\n')
    print(f'Built {output}')


if __name__ == '__main__':
    main()
