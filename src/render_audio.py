"""Render every lesson / level test into one Ogg-Opus pack + JSON index of segments.
Usage: python3 render_audio.py [ID-prefix-filter]
Skips packs that already exist and whose source text hash is unchanged.
"""
import json, os, sys, hashlib, subprocess
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, '..', 'web')
OUT = os.path.join(WEB, 'audio')
os.makedirs(OUT, exist_ok=True)
VOICES = os.path.join(ROOT, '..', '..', 'gt', 'voices')
k = Kokoro(os.path.join(VOICES, 'kokoro-f32.onnx'), os.path.join(VOICES, 'voices.bin'))
SR = 24000
QS_VOICE = 'am_michael'
TEACH = 'bf_emma'
# Speech speed rises gradually inside each level (lesson 1 -> 36) and from level to level.
SPEED_RANGE = [(0.82, 0.88), (0.88, 0.94), (0.94, 1.00), (1.00, 1.06)]


def lesson_speed(level, num):
    lo, hi = SPEED_RANGE[level]
    return round(lo + (hi - lo) * (num - 1) / 35, 3)


def lang(v):
    return 'en-gb' if v.startswith('b') else 'en-us'


_CACHE = {}


def tts(text, voice, speed):
    if voice.startswith('SLOW:'):
        a = tts(text, voice[5:], speed)
        import tempfile
        d = tempfile.mkdtemp(); i, o = d + '/i.wav', d + '/o.wav'
        sf.write(i, a, SR)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', i, '-af', 'atempo=0.8', o], check=True)
        b, _ = sf.read(o, dtype='float32'); return b
    key = (text, voice, speed)
    if key not in _CACHE:
        s, r = k.create(text, voice=voice, speed=speed, lang=lang(voice))
        if len(_CACHE) > 50: _CACHE.clear()
        _CACHE[key] = s.astype(np.float32)
    return _CACHE[key]


def pack(name, items):
    """items: list of (key, text, voice, speed). Writes <name>.ogg and returns index {key: [start, end]}."""
    gap = np.zeros(int(0.35 * SR), np.float32)
    parts, idx, t = [gap], {}, len(gap) / SR
    for key, text, voice, speed in items:
        a = tts(text, voice, speed)
        a = a / max(1e-6, np.max(np.abs(a))) * 0.9
        idx[key] = [round(t, 3), round(t + len(a) / SR, 3)]
        parts += [a, gap]
        t += (len(a) + len(gap)) / SR
    wav = os.path.join(OUT, name + '.wav')
    sf.write(wav, np.concatenate(parts), SR)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-c:a', 'libopus', '-b:a', '20k',
                    '-application', 'voip', os.path.join(OUT, name + '.ogg')], check=True)
    os.remove(wav)
    return idx


def lesson_items(L):
    sp = lesson_speed(L['level'], int(L['id'].rsplit('-', 1)[1]))
    eng = L['eng']['voice']
    it = []
    for i, (who, txt, _ar) in enumerate(L['dialogue']):
        it.append((f'd{i}', txt, QS_VOICE if who == 'QS' else eng, sp))
    for i, (en, ar) in enumerate(L['phrases']):
        it.append((f'p{i}', en, TEACH, 0.82))
    for i, (w, h) in enumerate(L['hard']):
        it.append((f'h{i}', w, TEACH, 0.75))
    for i, r in enumerate(L['read']):
        it.append((f'r{i}', r, TEACH, 0.85))
        it.append((f'rs{i}', r, 'SLOW:' + TEACH, 0.85))
    for i, t in enumerate(L['tasks']):
        it.append((f'm{i}', t['model'], QS_VOICE, sp))
    return it


def test_items(T):
    sp = SPEED_RANGE[T['level']][1]
    eng = T['eng']['voice']
    it = [(f'd{i}', txt, QS_VOICE if who == 'QS' else eng, sp) for i, (who, txt, _ar) in enumerate(T['dialogue'])]
    for i, r in enumerate(T['read']):
        it.append((f'r{i}', r, TEACH, 0.85))
    return it


SOUNDS = json.load(open(os.path.join(WEB, 'data', 'sounds.json'), encoding='utf-8'))


def main(flt=''):
    data = json.load(open(os.path.join(WEB, 'data', 'lessons.json'), encoding='utf-8'))
    idx_path = os.path.join(WEB, 'data', 'audio_index.json')
    index = json.load(open(idx_path)) if os.path.exists(idx_path) else {}
    jobs = [(L['id'], lesson_items(L)) for L in data['lessons']]
    jobs += [(f"TEST-{T['level']}-{T['version']}", test_items(T)) for T in data['tests']]
    sitems = []
    for si, s in enumerate(SOUNDS):
        for pi, pair in enumerate(s['pairs']):
            for wi, w in enumerate(pair):
                sitems.append((f's{si}_{pi}_{wi}', w.lower(), TEACH, 0.75))
    jobs.insert(0, ('SOUNDS', sitems))
    tests = [j for j in jobs if j[0].startswith('TEST')]
    jobs = [j for j in jobs if not j[0].startswith('TEST')]
    jobs = jobs[:1] + tests + jobs[1:]
    done = 0
    for name, items in jobs:
        if flt and not name.startswith(flt):
            continue
        h = hashlib.sha1(json.dumps(items).encode()).hexdigest()[:12]
        if name in index and index[name].get('hash') == h and os.path.exists(os.path.join(OUT, name + '.ogg')):
            continue
        seg = pack(name, items)
        index[name] = {'hash': h, 'seg': seg}
        json.dump(index, open(idx_path, 'w'))
        done += 1
        print('rendered', name, flush=True)
    print('done', done)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '')
