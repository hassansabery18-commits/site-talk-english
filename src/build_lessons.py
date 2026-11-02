"""Parse lesson DSL files (content/*.txt) into web/data/lessons.json.

Lesson block:
# <ID> | <English title> | <Arabic title>
ENG <Name>, <role>, <kokoro voice>
SCENE: <Arabic scene>
QS: / ENG: dialogue lines (in order)
P: <english phrase> = <arabic meaning>
H: <word> = <hint>
R: <read-aloud test sentence>
T: <task EN> | <task AR> | <model answer> | <key1; key2; ...>

Level test block:
## TEST <level> <version> | <English title>
ENG <Name>, <role>, <voice>
QS:/ENG: dialogue
Q: <question> | <a> | <b> | <c> | <d> | <correct letter>
V: <phrase question> | <a> | <b> | <c> | <d> | <correct letter>
R: <read sentence>
T: <task EN> | <task AR> | <model answer> | <keys>
"""
import json, re, sys, glob, os

LEVELS = {'B1': 0, 'B1+': 1, 'B2': 2, 'B2+': 3}


def parse(paths):
    lessons, tests, cur = [], [], None
    for path in paths:
        for raw in open(path, encoding='utf-8'):
            line = raw.rstrip('\n').strip()
            if not line or line.startswith('//'):
                continue
            if line.startswith('## TEST'):
                head, title = [s.strip() for s in line[2:].split('|', 1)]
                _, lv, ver = head.split()
                cur = {'kind': 'test', 'level': LEVELS[lv], 'version': int(ver), 'title': title,
                       'eng': None, 'dialogue': [], 'mcq': [], 'vocab': [], 'read': [], 'tasks': []}
                tests.append(cur)
                continue
            if line.startswith('# '):
                lid, ten, tar = [s.strip() for s in line[2:].split('|')]
                lv = lid.rsplit('-', 1)[0]
                cur = {'kind': 'lesson', 'id': lid, 'level': LEVELS[lv], 'title': ten, 'title_ar': tar,
                       'eng': None, 'scene': '', 'dialogue': [], 'phrases': [], 'hard': [], 'read': [], 'tasks': []}
                lessons.append(cur)
                continue
            if cur is None:
                raise ValueError(f'{path}: content before header: {line}')
            if line.startswith('ENG ') and not line.startswith('ENG:'):
                name, role, voice = [s.strip() for s in line[4:].split(',')]
                cur['eng'] = {'name': name, 'role': role, 'voice': voice}
            elif line.startswith('SCENE:'):
                cur['scene'] = line[6:].strip()
            elif line.startswith('QS:') or line.startswith('ENG:'):
                sp, txt = line.split(':', 1)
                en, _, ar = txt.partition('||')
                cur['dialogue'].append([sp, en.strip(), ar.strip()])
            elif line.startswith('P:'):
                en, ar = [s.strip() for s in line[2:].split('=', 1)]
                cur['phrases'].append([en, ar])
            elif line.startswith('H:'):
                w, h = [s.strip() for s in line[2:].split('=', 1)]
                cur['hard'].append([w, h])
            elif line.startswith('R:'):
                cur['read'].append(line[2:].strip())
            elif line.startswith('T:'):
                p = [s.strip() for s in line[2:].split('|')]
                if len(p) != 4:
                    raise ValueError(f'bad task in {cur.get("id", cur.get("title"))}: {line}')
                cur['tasks'].append({'q': p[0], 'q_ar': p[1], 'model': p[2],
                                     'keys': [k.strip() for k in p[3].split(';') if k.strip()]})
            elif line.startswith('Q:') or line.startswith('V:'):
                p = [s.strip() for s in line[2:].split('|')]
                if len(p) != 6 or p[5] not in 'abcd':
                    raise ValueError(f'bad MCQ: {line}')
                (cur['mcq'] if line[0] == 'Q' else cur['vocab']).append({'q': p[0], 'opts': p[1:5], 'ans': 'abcd'.index(p[5])})
            else:
                raise ValueError(f'{path}: unknown line: {line}')
    return lessons, tests


def check(lessons, tests):
    errs = []
    seen = set()
    for L in lessons:
        i = L['id']
        if i in seen: errs.append(f'duplicate id {i}')
        seen.add(i)
        if not L['eng']: errs.append(f'{i}: no ENG')
        if len(L['dialogue']) < 6: errs.append(f'{i}: dialogue too short')
        if any(not d[2] for d in L['dialogue']): errs.append(f'{i}: missing translation')
        if not (4 <= len(L['phrases']) <= 7): errs.append(f'{i}: phrases {len(L["phrases"])}')
        if len(L['hard']) != 3: errs.append(f'{i}: hard {len(L["hard"])}')
        if len(L['read']) != 5: errs.append(f'{i}: read {len(L["read"])}')
        if len(L['tasks']) != 2: errs.append(f'{i}: tasks {len(L["tasks"])}')
        for t in L['tasks']:
            if len(t['keys']) < 2: errs.append(f'{i}: task needs >=2 keys')
        for r in L['read']:
            n = len(r.split())
            if not 5 <= n <= 16: errs.append(f'{i}: read length {n}: {r}')
    for T in tests:
        tag = f'TEST {T["level"]}-{T["version"]}'
        if len(T['mcq']) != 10: errs.append(f'{tag}: mcq {len(T["mcq"])}')
        if len(T['vocab']) != 5: errs.append(f'{tag}: vocab {len(T["vocab"])}')
        if len(T['read']) != 5: errs.append(f'{tag}: read {len(T["read"])}')
        if len(T['tasks']) != 2: errs.append(f'{tag}: tasks {len(T["tasks"])}')
    return errs


if __name__ == '__main__':
    root = os.path.dirname(os.path.abspath(__file__))
    files = sorted(glob.glob(os.path.join(root, '..', 'content', '*.txt')))
    lessons, tests = parse(files)
    # Arabic translations kept in separate .tr files: "## ID" then one Arabic line per dialogue line
    tr, cid = {}, None
    for f in sorted(glob.glob(os.path.join(root, '..', 'content', '*.tr'))):
        for raw in open(f, encoding='utf-8'):
            t = raw.strip()
            if not t: continue
            if t.startswith('## '): cid = t[3:].strip(); tr[cid] = []
            else: tr[cid].append(t)
    for X in lessons + tests:
        key = X.get('id') or f"TEST-{X['level']}-{X['version']}"
        if key in tr:
            if len(tr[key]) != len(X['dialogue']):
                print('ERR', key, 'translation lines', len(tr[key]), 'dialogue', len(X['dialogue']))
            for d, a in zip(X['dialogue'], tr[key]): d[2] = a
    errs = check(lessons, tests)
    by = {}
    for L in lessons: by[L['level']] = by.get(L['level'], 0) + 1
    print('lessons per level', by, 'tests', len(tests))
    for e in errs: print('ERR', e)
    out = os.path.join(root, '..', 'web', 'data')
    os.makedirs(out, exist_ok=True)
    json.dump({'lessons': lessons, 'tests': tests}, open(os.path.join(out, 'lessons.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    if errs: sys.exit(1)
