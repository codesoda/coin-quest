"""Offline data/package checks. Builds use disposable templates, never root HTML."""
import base64
import array
import math
import hashlib
from html.parser import HTMLParser
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_web
import compose_music as composer
import export_web_assets as exporter
LEVELS = json.loads((ROOT / 'assets/levels.json').read_bytes())

TEMPLATE = '''<!doctype html><html><head><meta charset="utf-8">
<style>{{STYLE}}</style></head><body><canvas></canvas>
<script>{{GAME_DATA}}</script>
<script>{{CORE_JS}}</script><script>{{UI_JS}}</script>
<script>{{AUDIO_JS}}</script><script>{{MAIN_JS}}</script></body></html>'''
STYLE = 'body { margin: 0; font-family: sans-serif; }'
CORE = 'window.TEST_CORE = { ready: true };'
MAIN = 'window.TEST_READY = window.TEST_CORE.ready && window.COIN_QUEST_DATA.version === 1;'


def decode(uri):
    return base64.b64decode(uri.split(',', 1)[1], validate=True)


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.active = False
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))
        if tag == 'script':
            self.active = True
            self.scripts.append('')

    def handle_endtag(self, tag):
        if tag == 'script':
            self.active = False

    def handle_data(self, text):
        if self.active:
            self.scripts[-1] += text


class WebExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = exporter.export_data()
        cls.manifest = json.loads((ROOT / 'assets/manifest.json').read_bytes())

    def test_all_three_levels_match_every_source_field(self):
        expected = json.loads(json.dumps(LEVELS))
        self.assertEqual(self.data['levels'], expected)
        self.assertEqual(len(expected), 3)
        for stage in self.data['levels']:
            self.assertEqual(stage['length'], 2560)
            self.assertEqual(stage['spawn'], dict(x=80, y=-112))
            self.assertEqual(stage['checkpoint'], dict(x=1248, y=-112))
            self.assertEqual(stage['flag'], dict(x=2496, y=-112))
            self.assertEqual(len(stage['coins']), 24)
            self.assertEqual(len(stage['enemies']), 4)
            self.assertEqual(len(stage['powers']), 3)
            self.assertTrue(all(p['state'] == -1 for p in stage['powers']))
            self.assertTrue(all(1 <= t['geom'] <= len(stage['geometry']) for t in stage['tiles']))
        self.assertEqual(self.data['viewport'], dict(width=480, height=360))
        self.assertEqual(self.data['version'], 1)

    def test_exact_image_bytes_dimensions_anchors_and_hashes(self):
        self.assertEqual(set(self.data['images']), set(self.manifest['images']))
        self.assertEqual(len(self.data['images']), 25)
        for name, rel in self.manifest['images'].items():
            with self.subTest(image=name):
                image = self.data['images'][name]
                raw = (ROOT / rel).read_bytes()
                self.assertTrue(image['src'].startswith('data:image/png;base64,'))
                self.assertEqual(decode(image['src']), raw)
                self.assertEqual((image['width'], image['height']), struct.unpack('>II', raw[16:24]))
                self.assertEqual(image['anchor'], self.manifest['metadata'][name]['anchor'])
                self.assertEqual(self.data['provenance']['images'][name], dict(path=rel, sha256=hashlib.sha256(raw).hexdigest()))

    def test_drawing_scales_match_native_contract(self):
        scales = {name: (480 / image['width'] if name in exporter.BACKDROPS else
                         exporter.HEIGHTS[name] / image['height'] if name in exporter.HEIGHTS else 32 / image['width'])
                  for name, image in self.data['images'].items()}
        for name, image in self.data['images'].items():
            with self.subTest(image=name):
                scale = image['drawHeight'] / image['height'] if image['drawHeight'] else image['drawWidth'] / image['width']
                self.assertEqual(scale, scales[name])
                if name.startswith('player_'):
                    self.assertEqual((image['width'], image['height']), (249, 270))
                    self.assertEqual(image['anchor'], [124.5, 270])
                    self.assertEqual(image['drawHeight'], 32)
        self.assertEqual(self.data['provenance']['player'], dict(normalDrawHeight=32, grownDrawHeight=48,
                         normalCollisionHeight=28, grownCollisionHeight=42, normalHalfWidth=10, grownHalfWidth=14))

    def test_exact_native_wav_bytes_and_hashes(self):
        manifest = json.loads((ROOT / 'assets/sounds/manifest.json').read_bytes())
        self.assertEqual(set(self.data['sounds']), set(exporter.SOUNDS))
        self.assertEqual(len(self.data['sounds']), 9)
        for name, sound in manifest['sounds'].items():
            with self.subTest(sound=name):
                exported = self.data['sounds'][name]
                raw = (ROOT / sound['path']).read_bytes()
                self.assertTrue(exported['src'].startswith('data:audio/wav;base64,'))
                self.assertEqual(decode(exported['src']), raw)
                self.assertEqual(exported['sha256'], hashlib.sha256(raw).hexdigest())
                self.assertEqual(exported['sha256'], sound['sha256'])
                with wave.open(io.BytesIO(raw)) as wav:
                    self.assertEqual(wav.getnframes(), sound['samples'])
                    self.assertEqual(wav.getframerate(), sound['sampleRate'])

    def test_native_integrity_snapshot_and_original_source_provenance(self):
        contract = json.loads((ROOT / 'assets/native-integrity.json').read_bytes())
        self.assertEqual(hashlib.sha256(exporter.json_text(self.data['levels']).encode()).hexdigest(),
                         contract['levelsSha256'])
        for group in ('images', 'sounds', 'music'):
            for name, record in contract[group].items():
                self.assertEqual(hashlib.sha256((ROOT / record['path']).read_bytes()).hexdigest(), record['sha256'], name)
        for relative, record in self.manifest['sources'].items():
            self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), record['sha256'])

    def test_provenance_hashes_source_bytes_without_timestamps(self):
        for rel in ('assets/levels.json', 'assets/manifest.json', 'assets/sounds/manifest.json'):
            self.assertEqual(self.data['provenance']['sources'][rel], hashlib.sha256((ROOT / rel).read_bytes()).hexdigest())
        self.assertNotIn(str(ROOT), exporter.json_text(self.data))
        self.assertNotIn('timestamp', self.data['provenance'])

    def test_export_is_deterministic_and_does_not_mutate_levels(self):
        before = json.dumps(LEVELS)
        self.assertEqual(exporter.json_text(self.data), exporter.json_text(exporter.export_data()))
        self.assertEqual(json.dumps(LEVELS), before)

    def test_generated_export_matches_sources(self):
        self.assertEqual((ROOT / 'web/game-data.json').read_text(), exporter.json_text(self.data) + '\n')

    def test_script_safe_json_round_trips_hostile_text(self):
        payload = {'value': '</ScRiPt><script>throw 1</script><!-- & > \u2028\u2029 {{MAIN_JS}}'}
        safe = build_web.script_safe_json(payload)
        self.assertNotIn('<', safe)
        self.assertNotIn('\u2028', safe)
        self.assertEqual(json.loads(safe), payload)
        html = build_web.assemble_html(TEMPLATE, STYLE, CORE, MAIN, payload)
        parser = Scripts()
        parser.feed(html)
        self.assertEqual(len(parser.scripts), 5)
        self.assertIn('{{MAIN_JS}}', parser.scripts[0])
        self.assertEqual(json.loads(parser.scripts[0].removeprefix('window.COIN_QUEST_DATA = ').removesuffix(';')), payload)

    def test_inline_classic_scripts_work_without_fetch_or_modules(self):
        if not shutil.which('node'):
            self.skipTest('Node is not installed')
        html = build_web.assemble_html(TEMPLATE, STYLE, CORE, MAIN, self.data)
        parser = Scripts()
        parser.feed(html)
        script = 'global.window = global;\n' + '\n'.join(parser.scripts) + '\nif (!window.TEST_READY) process.exit(1);'
        result = subprocess.run(['node'], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for tag, attrs in parser.tags:
            self.assertNotIn('src', attrs)
            self.assertNotIn('href', attrs)
            self.assertNotEqual(attrs.get('type'), 'module')

    def test_template_requires_each_placeholder_once_and_valid_order(self):
        for token in build_web.TOKENS:
            for replacement in ('', ('{{' + token + '}}') * 2):
                with self.subTest(token=token, replacement=replacement), self.assertRaisesRegex(exporter.ExportError, 'exactly one'):
                    build_web.assemble_html(TEMPLATE.replace('{{' + token + '}}', replacement), STYLE, CORE, MAIN, {})
        with self.assertRaisesRegex(exporter.ExportError, 'before'):
            build_web.assemble_html(TEMPLATE.replace('{{CORE_JS}}', '{{TEMP}}').replace('{{MAIN_JS}}', '{{CORE_JS}}').replace('{{TEMP}}', '{{MAIN_JS}}'), STYLE, CORE, MAIN, {})

    def test_rejects_network_local_dependencies_modules_and_unsafe_closers(self):
        for resource in ('<script src="https://example.org/a.js"></script>', '<img src="assets/a.png">',
                         '<link href="//example.org/a.css">', '<script type="module">import x from "x"</script>'):
            with self.subTest(resource=resource), self.assertRaises(exporter.ExportError):
                build_web.assemble_html(TEMPLATE + resource, STYLE, CORE, MAIN, {})
        for style in ('@import "https://example.org/a.css";', 'a{background:url(https://example.org/a.png)}', '</STYLE>'):
            with self.subTest(style=style), self.assertRaises(exporter.ExportError):
                build_web.assemble_html(TEMPLATE, style, CORE, MAIN, {})
        with self.assertRaisesRegex(exporter.ExportError, 'unsafe'):
            build_web.assemble_html(TEMPLATE, STYLE, CORE + '"</ScRiPt>"', MAIN, {})


class MusicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.score_raw = (ROOT / composer.SCORE).read_bytes()
        cls.score = json.loads(cls.score_raw)
        cls.raw = (ROOT / composer.WAV).read_bytes()
        cls.meta = json.loads((ROOT / composer.META).read_bytes())
        with wave.open(io.BytesIO(cls.raw), 'rb') as wav:
            cls.params = wav.getparams()
            cls.pcm = array.array('h', wav.readframes(wav.getnframes()))
        if sys.byteorder != 'little':
            cls.pcm.byteswap()

    def test_score_is_arranged_original_eight_bar_swing_with_all_parts(self):
        composer.validate(self.score)
        self.assertEqual(self.score['license'], 'CC0-1.0')
        self.assertEqual(len(self.score['progression']), 8)
        self.assertGreater(len(set(self.score['progression'])), 3)
        for bar in range(8):
            voices = {e['voice'] for e in self.score['events'] if bar*4 <= e['beat'] < (bar+1)*4}
            self.assertEqual(voices, composer.VOICES)
        self.assertGreater(sum(e['beat'] % 1 != 0 for e in self.score['events']), 100)
        self.assertEqual(self.score['swing'], .56)

    def test_pcm_duration_exact_bar_grid_and_loop_points(self):
        p = self.params
        self.assertEqual((p.nchannels, p.sampwidth, p.framerate, p.comptype), (1, 2, 22050, 'NONE'))
        self.assertEqual(p.nframes, 352800)
        self.assertEqual(p.nframes/p.framerate, 8*4*60/self.score['tempo'])
        self.assertEqual((self.meta['loopStart'],self.meta['loopEnd'],self.meta['duration']), (0,16,16))
        self.assertLess(len(self.raw), 710000)

    def test_waveform_peak_rms_dc_and_cyclic_seam_not_silent(self):
        metrics = composer.metrics(self.pcm, self.params.framerate)
        self.assertEqual(metrics,self.meta['metrics'])
        self.assertLess(metrics['peak'], .69)
        self.assertGreater(metrics['rms'], .10)
        self.assertLess(metrics['rms'], .146)
        self.assertLess(abs(metrics['dc']), .00001)
        self.assertLess(metrics['seamStep'], .01)
        self.assertLess(metrics['seamSlopeChange'], .002)
        self.assertGreater(min(metrics['headRms'],metrics['tailRms']), .03)
        # Each 20ms region has signal; there is no padded silent looping gap.
        for start in range(0,len(self.pcm),441):
            self.assertGreater(sum(v*v for v in self.pcm[start:start+441]), 1000)
        self.assertNotIn(32767,self.pcm)
        self.assertNotIn(-32768,self.pcm)

    def test_background_mix_headroom_against_original_effects(self):
        effects = exporter.export_data()['sounds']
        peaks, rms = [], []
        for effect in effects.values():
            with wave.open(io.BytesIO(decode(effect['src']))) as wav:
                pcm = array.array('h',wav.readframes(wav.getnframes()))
            if sys.byteorder != 'little':
                pcm.byteswap()
            peaks.append(max(map(abs,pcm))/32768)
            rms.append(math.sqrt(sum((v/32768)**2 for v in pcm)/len(pcm)))
        # Conservative in-phase bound for the eight-source SFX pool plus music.
        self.assertLess(8*max(peaks)*.22 + self.meta['metrics']['peak']*.10,.70)
        self.assertLess(self.meta['metrics']['rms']*.10,min(rms)*.22*.60)

    def test_full_offline_render_is_byte_reproducible(self):
        raw, metrics, count = composer.render(self.score)
        self.assertEqual(raw,self.raw)
        self.assertEqual(metrics,self.meta['metrics'])
        self.assertEqual(count,self.params.nframes)

    def test_embedded_music_hash_and_score_generator_provenance(self):
        music = exporter.export_data()['music']['tracks']['grassland']
        self.assertEqual(decode(music.pop('src')),self.raw)
        self.assertEqual(music,self.meta)
        self.assertEqual(music['sha256'],hashlib.sha256(self.raw).hexdigest())
        for rel, digest in [(composer.SCORE,music['provenance']['scoreSha256']),
                            ('scripts/compose_music.py',music['provenance']['generatorSha256'])]:
            self.assertEqual(hashlib.sha256((ROOT/rel).read_bytes()).hexdigest(),digest)

    def test_rejects_invalid_score(self):
        for key, value in [('tempo',0),('bars',7),('sampleRate',0),('swing',1)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                composer.render({**self.score,key:value})


class SceneMusicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tracks = exporter.export_data()['music']['tracks']
        cls.scores = {theme: json.loads((ROOT / paths[0]).read_bytes()) for theme, paths in composer.TRACKS.items()}

    def test_explicit_three_track_contract_and_original_grassland_bytes(self):
        music = exporter.export_data()['music']
        self.assertEqual(set(music), {'defaultTheme','tracks'})
        self.assertEqual(music['defaultTheme'],'grassland')
        self.assertEqual(set(music['tracks']), {'grassland','underground','castle'})
        self.assertEqual(hashlib.sha256((ROOT / composer.WAV).read_bytes()).hexdigest(),
                         '16852361964fe96fe2f2ff6f37013c7c80c49d1fab12ea2b405ba59c6aa2ccec')
        html = (ROOT / 'index.html').read_text()
        for track in self.tracks.values():
            self.assertEqual(html.count(track['src']), 1, 'no duplicate data URI')

    def test_original_distinct_melodies_rhythms_chords_not_transpositions(self):
        signatures, rhythms, harmonies = [], [], []
        for theme, score in self.scores.items():
            composer.validate_theme(score, theme)
            lead = [e for e in score['events'] if e['voice']=='brass']
            pitches = [e['notes'][0] for e in lead]
            signatures.append(tuple(n-pitches[0] for n in pitches))
            rhythms.append(tuple((e['beat'], e['duration']) for e in lead))
            harmonies.append(tuple(score['progression']))
            self.assertEqual(len(score['progression']),8)
            for bar in range(8):
                self.assertEqual({e['voice'] for e in score['events'] if bar*4<=e['beat']<(bar+1)*4},composer.VOICES)
        self.assertEqual(len(set(signatures)),3)
        self.assertEqual(len(set(rhythms)),3)
        self.assertEqual(len(set(harmonies)),3)
        self.assertEqual([self.tracks[t]['tempo'] for t in composer.TRACKS],[120,105,120])
        self.assertEqual({t['timbreProfile'] for t in self.tracks.values()},{'parade','cavern','regal'})

    def test_each_scene_decodes_on_exact_eight_bar_sample_grid(self):
        for theme, track in self.tracks.items():
            with self.subTest(theme=theme), wave.open(io.BytesIO(decode(track['src']))) as wav:
                self.assertEqual((wav.getnchannels(),wav.getsampwidth(),wav.getframerate()),(1,2,22050))
                count = 8*4*60/track['tempo']*22050
                self.assertEqual(count,round(count))
                self.assertEqual(wav.getnframes(),count)
                self.assertEqual((track['loopStart'],track['loopEnd']), (0,count/22050))
                self.assertEqual(track['duration'],count/22050)

    def test_each_scene_safe_mix_seam_no_clipping_or_silent_windows(self):
        effects = exporter.export_data()['sounds']
        sfx_peaks, sfx_rms = [], []
        for effect in effects.values():
            with wave.open(io.BytesIO(decode(effect['src']))) as wav:
                pcm = array.array('h',wav.readframes(wav.getnframes()))
            if sys.byteorder != 'little': pcm.byteswap()
            m = composer.metrics(pcm,22050); sfx_peaks.append(m['peak']); sfx_rms.append(m['rms'])
        for theme, track in self.tracks.items():
            with self.subTest(theme=theme):
                with wave.open(io.BytesIO(decode(track['src']))) as wav:
                    pcm = array.array('h',wav.readframes(wav.getnframes()))
                if sys.byteorder != 'little': pcm.byteswap()
                m = composer.metrics(pcm,22050)
                self.assertEqual(m,track['metrics'])
                self.assertGreater(m['minWindowRms'],.0001)
                self.assertLessEqual(m['peak'],.681)
                self.assertGreater(m['rms'],.06); self.assertLessEqual(m['rms'],.146)
                self.assertLess(abs(m['dc']),.00001)
                self.assertLess(m['seamStep'],.025); self.assertLess(m['seamSlopeChange'],.025)
                self.assertGreater(min(m['headRms'],m['tailRms']),.003)
                for start in range(0,len(pcm),441):
                    self.assertGreater(sum(v*v for v in pcm[start:start+441]),1000)
                self.assertNotIn(32767,pcm); self.assertNotIn(-32768,pcm)
                self.assertLess(8*max(sfx_peaks)*.22 + m['peak']*.10,.70)
                self.assertLess(m['rms']*.10,min(sfx_rms)*.22*.60)

    def test_each_scene_exact_score_generator_and_wav_provenance(self):
        for theme, (score,wav,meta) in composer.TRACKS.items():
            track = self.tracks[theme]
            self.assertEqual(track['theme'],theme)
            self.assertEqual(track['title'],self.scores[theme]['title'])
            self.assertEqual(track['provenance']['license'],'CC0-1.0')
            self.assertEqual(track['provenance']['score'],score)
            self.assertEqual(decode(track['src']),(ROOT / wav).read_bytes())
            for path, digest in [(score,track['provenance']['scoreSha256']),
                                 (wav,track['sha256']),('scripts/compose_music.py',track['provenance']['generatorSha256'])]:
                self.assertEqual(hashlib.sha256((ROOT / path).read_bytes()).hexdigest(),digest)

    def test_export_reads_tracks_without_rendering(self):
        with patch.object(composer, 'render', side_effect=AssertionError('export must not synthesize')):
            self.assertEqual(exporter.export_data()['music']['tracks'], self.tracks)

    def test_new_scene_renders_are_deterministic(self):
        for theme in ('underground','castle'):
            raw, metrics, count = composer.render(self.scores[theme])
            self.assertEqual(raw,decode(self.tracks[theme]['src']))
            self.assertEqual(metrics,self.tracks[theme]['metrics'])
            self.assertEqual(count,self.tracks[theme]['samples'])

    def test_rejects_wrong_scene_profile_or_tempo(self):
        for theme, score in self.scores.items():
            for key, value in [('theme','other'),('timbreProfile','unknown'),('tempo',103),('tempo',125)]:
                with self.subTest(theme=theme,key=key), self.assertRaises(ValueError):
                    composer.validate_theme({**score,key:value},theme)


class DisposableBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.manifest = json.loads((ROOT / 'assets/manifest.json').read_bytes())
        sounds = json.loads((ROOT / 'assets/sounds/manifest.json').read_bytes())
        sources = ['assets/levels.json', 'assets/manifest.json', 'assets/sounds/manifest.json',
                   *(v['path'] for v in sounds['sounds'].values()),
                   'scripts/build_web.py', 'scripts/export_web_assets.py', 'scripts/compose_music.py',
                   *(path for paths in composer.TRACKS.values() for path in paths), *self.manifest['images'].values()]
        for rel in sources:
            target = self.root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / rel, target)
        (self.root / 'web').mkdir(exist_ok=True)
        for name, text in {'template.html': TEMPLATE, 'style.css': STYLE, 'core.js': CORE, 'ui.js': '// UI stub', 'audio.js': '// Audio stub', 'main.js': MAIN}.items():
            (self.root / 'web' / name).write_text(text)

    def test_build_is_deterministic_and_preserves_every_input(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        output = build_web.build(self.root)
        self.assertEqual(output, self.root / 'index.html')
        first = output.read_bytes()
        self.assertEqual((self.root / 'dist/index.html').read_bytes(), first)
        export = (self.root / 'web/game-data.json').read_bytes()
        self.assertEqual(build_web.build(self.root).read_bytes(), first)
        self.assertEqual((self.root / 'web/game-data.json').read_bytes(), export)
        for rel, original in before.items():
            self.assertEqual((self.root / rel).read_bytes(), original, str(rel))
        self.assertFalse((self.root / 'project.json').exists())
        self.assertFalse((self.root / 'levels.json').exists())
        self.assertIn(b'Native build source SHA-256', first)
        self.assertNotIn(str(self.root).encode(), first)

    def test_build_generates_missing_music_and_requires_source_score(self):
        for theme, (score, wav, meta) in composer.TRACKS.items():
            for relative in (wav, meta):
                (self.root / relative).unlink()
        with self.assertRaisesRegex(exporter.ExportError, 'funky-fanfare.wav'):
            exporter.export_data(self.root)
        build_web.build(self.root)
        for theme, (score, wav, meta) in composer.TRACKS.items():
            self.assertEqual((self.root / wav).read_bytes(), (ROOT / wav).read_bytes())
            path = self.root / score
            raw = path.read_bytes()
            path.unlink()
            with self.subTest(theme=theme), self.assertRaisesRegex(exporter.ExportError, score):
                build_web.build(self.root)
            path.write_bytes(raw)

    def test_export_rejects_invalid_scene_metadata_and_loops(self):
        for theme, (score, wav, meta) in composer.TRACKS.items():
            path = self.root / meta
            raw = path.read_bytes()
            for key, value in [('theme','bogus'),('tempo',0),('loopEnd',0),('samples',12),('bars',7)]:
                data = json.loads(raw); data[key] = value
                path.write_text(json.dumps(data))
                with self.subTest(theme=theme, key=key), self.assertRaisesRegex(exporter.ExportError, 'Invalid music'):
                    exporter.export_data(self.root)
            path.write_bytes(raw)

    def test_export_rejects_missing_or_stale_music_inputs(self):
        for relative in (*(path for paths in composer.TRACKS.values() for path in paths), 'scripts/compose_music.py'):
            target = self.root / relative
            raw = target.read_bytes()
            target.unlink()
            with self.subTest(relative=relative), self.assertRaisesRegex(exporter.ExportError, 'Missing required input'):
                exporter.export_data(self.root)
            target.write_bytes(raw)
        target = self.root / composer.SCORE
        target.write_bytes(target.read_bytes() + b' ')
        with self.assertRaisesRegex(exporter.ExportError, 'Stale music asset'):
            exporter.export_data(self.root)

    def test_cli_build_works_from_an_unrelated_directory(self):
        result = subprocess.run([sys.executable, str(self.root / 'scripts/build_web.py')], cwd='/', text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'index.html').is_file())

    def test_missing_web_input_fails_before_writing_outputs(self):
        for name in ('template.html', 'style.css', 'core.js', 'ui.js', 'audio.js', 'main.js'):
            path = self.root / 'web' / name
            content = path.read_bytes()
            path.unlink()
            with self.subTest(name=name), self.assertRaisesRegex(exporter.ExportError, name):
                build_web.build(self.root)
            self.assertFalse((self.root / 'index.html').exists())
            self.assertFalse((self.root / 'web/game-data.json').exists())
            path.write_bytes(content)

    def test_missing_original_inputs_fail_clearly(self):
        for rel in ('assets/manifest.json', 'assets/levels.json', 'assets/sounds/manifest.json', self.manifest['images']['player_idle']):
            path = self.root / rel
            original = path.read_bytes()
            path.unlink()
            with self.subTest(path=rel), self.assertRaisesRegex(exporter.ExportError, 'Missing required input'):
                exporter.export_data(self.root)
            path.write_bytes(original)

    def test_empty_template_fails_without_placeholder_output(self):
        (self.root / 'web/template.html').write_text(' ')
        with self.assertRaisesRegex(exporter.ExportError, 'Empty required input'):
            build_web.build(self.root)
        self.assertFalse((self.root / 'index.html').exists())

    def test_missing_manifest_key_anchor_and_invalid_png_fail(self):
        manifest_path = self.root / 'assets/manifest.json'
        original = manifest_path.read_bytes()
        del self.manifest['images']['player_idle']
        manifest_path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(exporter.ExportError, 'Missing required manifest images: player_idle'):
            exporter.export_data(self.root)
        self.manifest = json.loads(original)
        del self.manifest['metadata']['player_idle']['anchor']
        manifest_path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(exporter.ExportError, 'anchor'):
            exporter.export_data(self.root)
        manifest_path.write_bytes(original)
        (self.root / self.manifest['images']['player_idle']).write_bytes(b'not a PNG')
        with self.assertRaisesRegex(exporter.ExportError, 'expected a PNG'):
            exporter.export_data(self.root)

    def test_export_reads_levels_from_selected_source_root(self):
        path = self.root / 'assets/levels.json'
        levels = json.loads(path.read_bytes())
        levels[0]['spawn']['x'] = 81
        path.write_text(json.dumps(levels))
        self.assertEqual(exporter.export_data(self.root)['levels'][0]['spawn']['x'], 81)
        self.assertEqual(LEVELS[0]['spawn']['x'], 80)

    def test_missing_or_modified_native_effect_fails_without_synthesis(self):
        path = self.root / 'assets/sounds/coin.wav'
        original = path.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(exporter.ExportError, 'Missing required input'):
            exporter.export_data(self.root)
        path.write_bytes(original + b'changed')
        with self.assertRaisesRegex(exporter.ExportError, 'sound hash mismatch'):
            exporter.export_data(self.root)

    def test_rejects_escaping_asset_paths_and_zero_based_geometry(self):
        path = self.root / 'assets/sounds/manifest.json'
        sounds = json.loads(path.read_bytes())
        sounds['sounds']['coin']['path'] = '../outside.wav'
        path.write_text(json.dumps(sounds))
        with self.assertRaisesRegex(exporter.ExportError, 'inside the project'):
            exporter.export_data(self.root)
        levels = json.loads((self.root / 'assets/levels.json').read_bytes())
        levels[0]['tiles'][0]['geom'] = 0
        with self.assertRaisesRegex(exporter.ExportError, 'one-based'):
            exporter.native_levels(json.dumps(levels))

    def test_cli_missing_input_has_actionable_error(self):
        (self.root / 'web/core.js').unlink()
        result = subprocess.run([sys.executable, str(self.root / 'scripts/build_web.py')], text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Build failed: Missing required input:', result.stderr)
        self.assertIn('web/core.js', result.stderr)
        self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
