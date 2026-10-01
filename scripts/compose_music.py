#!/usr/bin/env python3
"""Render the three original CC0 scene scores to a cyclic, mono PCM WAV.

Standard library only. No runtime synthesis, samples, or downloads.
Release tails and profile-specific echoes wrap into the next cycle, not a silent pad.
"""
import array
import hashlib
import io
import json
import math
from pathlib import Path
import random
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
SCORE = 'web/assets/funky-fanfare.score.json'
WAV = 'web/assets/funky-fanfare.wav'
META = 'web/assets/funky-fanfare.json'
TRACKS = {
    'grassland': (SCORE, WAV, META),
    'underground': tuple('web/assets/lantern-grotto' + ext for ext in ('.score.json', '.wav', '.json')),
    'castle': tuple('web/assets/velvet-battlements' + ext for ext in ('.score.json', '.wav', '.json')),
}
# Six arrangement roles; profiles change their explicitly validated timbres.
PROFILES = {'parade', 'cavern', 'regal'}
VOICES = {'brass', 'stab', 'bass', 'kick', 'snare', 'hat'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def validate(score):
    required = {'version', 'bars', 'beatsPerBar', 'tempo', 'sampleRate', 'swing',
                'license', 'events', 'title', 'seed', 'provenance', 'progression'}
    if not required <= score.keys() or score.get('timbreProfile', 'parade') not in PROFILES:
        raise ValueError('Invalid music score fields or timbre profile')
    if (score['version'] != 1 or score['bars'] != 8 or score['beatsPerBar'] != 4
            or not 104 <= score['tempo'] <= 124 or score['sampleRate'] != 22050
            or not .5 <= score['swing'] <= .6 or score['license'] != 'CC0-1.0'):
        raise ValueError('Invalid music score metadata')
    if {e['voice'] for e in score['events']} != VOICES:
        raise ValueError('Music score requires all six voices')
    for e in score['events']:
        if not (0 <= e['beat'] < 32 and 0 < e['duration'] <= 4 and 0 < e['velocity'] <= 1):
            raise ValueError('Invalid music event')
        pitched = e['voice'] in {'brass', 'stab', 'bass'}
        if (pitched != bool(e['notes']) or any(not isinstance(n, int) or not 24 <= n <= 96 for n in e['notes'])):
            raise ValueError('Invalid music pitches')


def metrics(pcm, rate):
    values = [s / 32768 for s in pcm]
    edge = round(rate * .02)
    rms = lambda seq: math.sqrt(sum(x*x for x in seq) / len(seq))
    return dict(peak=max(map(abs, values)), rms=rms(values), dc=sum(values)/len(values),
                seamStep=abs(values[0]-values[-1]),
                seamSlopeChange=abs((values[1]-values[0])-(values[0]-values[-1])),
                headRms=rms(values[:edge]), tailRms=rms(values[-edge:]),
                minWindowRms=min(rms(values[i:i+edge]) for i in range(0,len(values),edge)),
                maxStep=max(abs(b-a) for a, b in zip(values, values[1:])))


def render(score):
    validate(score)
    profile = score.get('timbreProfile', 'parade')
    rate = score['sampleRate']
    seconds = 60 / score['tempo']
    count = round(score['bars'] * score['beatsPerBar'] * seconds * rate)
    mix = [0.0] * count
    tau = math.tau
    # Piecewise beat warp leaves all bar lines exact; offbeats get gentle swing.
    def swing(beat):
        whole = math.floor(beat)
        f = beat-whole
        return whole + (f*2*score['swing'] if f <= .5 else score['swing']+(f-.5)*2*(1-score['swing']))
    for index, e in enumerate(score['events']):
        voice = e['voice']
        start = round(swing(e['beat']) * seconds * rate)
        hold = (swing(e['beat']+e['duration'])-swing(e['beat'])) * seconds
        release = {'brass':.10, 'stab':.085, 'bass':.045}.get(voice, .025)
        if profile == 'cavern' and voice in ('brass', 'stab'):
            release = .28
        duration = hold+release
        rng = random.Random(score['seed']+index)
        filtered = previous = 0.0
        frequencies = [440 * 2**((n-69)/12) for n in e['notes']]
        for i in range(math.ceil(duration*rate)):
            t = i/rate
            # Raised-cosine attack/release have no amplitude discontinuity.
            attack = min(1, t/({'brass':.014, 'stab':.009, 'bass':.007}.get(voice,.003)))
            env = (.5-.5*math.cos(math.pi*attack))
            if t > hold:
                env *= .5+.5*math.cos(math.pi*min(1,(t-hold)/release))
            if profile == 'cavern' and voice in ('brass', 'stab'):
                # Hollow sine/odd-partial pluck, soft onset and a rounded decay.
                signal = sum(math.sin(tau*f*t) + .16*math.sin(3*tau*f*t)
                             + .04*math.sin(5*tau*f*t) for f in frequencies)
                signal *= .24*math.exp(-t*5.5)/len(frequencies)**.65
            elif voice in ('brass', 'stab'):
                signal = 0.0
                for f in frequencies:
                    phase = tau*f*t + .018*math.sin(tau*5*t)
                    # Mellow, band-limited brass: no sawtooth discontinuities.
                    signal += sum(a*math.sin(h*phase) for h,a in enumerate(((1,.34,.17,.065,.02) if profile == 'regal' else (1,.42,.20,.09,.035)),1))
                signal /= len(frequencies)**.65
                signal *= (.65+.35*math.exp(-t*14)) * (.19 if voice=='brass' else .14)
            elif voice == 'bass':
                phase = tau*frequencies[0]*t
                signal = .26*(math.sin(phase)+.22*math.sin(2*phase)+.07*math.sin(3*phase))*math.exp(-t*1.8)
                if profile == 'cavern':
                    signal = .25*math.sin(phase)*math.exp(-t*3.2)
            elif voice == 'kick':
                phase = tau*(49*t + 58*.028*(1-math.exp(-t/.028)))
                signal = .29*math.sin(phase)*math.exp(-t*19)
            else:
                noise = rng.uniform(-1,1)
                filtered += .32*(noise-filtered)
                if voice == 'snare':
                    signal = (.14*filtered+.06*math.sin(tau*177*t))*math.exp(-t*32)
                else:
                    high = noise-previous
                    previous = noise
                    signal = .025*high*math.exp(-t*65)
            sample = signal*env*e['velocity']
            mix[(start+i)%count] += sample
            if voice in ('brass','stab'):
                taps = ((seconds*.75,.26),(seconds*1.5,.12)) if profile == 'cavern' else ((.073,.13),(.119,.065))
                for delay, gain in taps:
                    mix[(start+i+round(delay*rate))%count] += sample*gain
    # Remove DC globally; fixed gain normalization, never a pumping compressor.
    mean = sum(mix)/count
    mix = [v-mean for v in mix]
    rms = math.sqrt(sum(v*v for v in mix)/count)
    scale = min(.68/max(map(abs,mix)), .145/rms)
    pcm = array.array('h', (round(v*scale*32767) for v in mix))
    checks = metrics(pcm,rate)
    if not (checks['peak'] <= .681 and .06 < checks['rms'] <= .146
            and checks['seamStep'] < .025 and checks['seamSlopeChange'] < .025
            and min(checks['headRms'],checks['tailRms']) > .003
            and checks['minWindowRms'] > .0001):
        raise ValueError(f'Music waveform checks failed: {checks}')
    if sys.byteorder != 'little':
        pcm.byteswap()
    output = io.BytesIO()
    with wave.open(output,'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())
    return output.getvalue(), checks, count


def validate_theme(score, theme):
    validate(score)
    expected = {'grassland': ('parade', 112, 120), 'underground': ('cavern', 104, 112),
                'castle': ('regal', 116, 124)}[theme]
    if (score.get('theme', 'grassland') != theme or
            score.get('timbreProfile', 'parade') != expected[0] or
            not expected[1] <= score['tempo'] <= expected[2]):
        raise ValueError(f'Invalid music theme/profile/tempo: {theme}')
    return expected[0]


def compose_track(root, theme):
    score_path, wav_path, meta_path = TRACKS[theme]
    path = root / score_path
    if not path.is_file():
        raise ValueError(f'Missing required music score for {theme}: {path}')
    raw = path.read_bytes()
    score = json.loads(raw)
    profile = validate_theme(score, theme)
    wav, checks, samples = render(score)
    metadata = dict(title=score['title'], theme=theme, timbreProfile=profile,
                    tempo=score['tempo'], bars=score['bars'],
                    beatsPerBar=score['beatsPerBar'], sampleRate=score['sampleRate'], channels=1,
                    samples=samples, duration=samples/score['sampleRate'], loopStart=0,
                    loopEnd=samples/score['sampleRate'], sha256=digest(wav), metrics=checks,
                    provenance=dict(description=score['provenance'], license=score['license'],
                                    score=score_path, scoreSha256=digest(raw), generator='scripts/compose_music.py',
                                    generatorSha256=digest((root/'scripts/compose_music.py').read_bytes())))
    # Avoid even a timestamp change when bytes match.
    for relative, content in ((wav_path,wav),(meta_path,(json.dumps(metadata,sort_keys=True,indent=2)+'\n').encode())):
        path = root / relative
        if not path.exists() or path.read_bytes() != content:
            path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(content)
    return metadata


def compose(root=ROOT):
    return {theme: compose_track(Path(root), theme) for theme in TRACKS}


if __name__ == '__main__':
    print(json.dumps(compose(),indent=2))
