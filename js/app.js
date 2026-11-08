// Site Talk English — offline speaking & pronunciation trainer.
import { align, normWords, fluency, gradeTask, mastery, lessonPassed, WPM_TARGET, setNames } from './scoring.js';
import * as C from './coach.js';

const LEVEL_NAMES = ['B1', 'B1+', 'B2', 'B2+'];
const MINUTE_STEPS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 30];
const UP_AFTER = 3;
const PRON_PASS = 70;        // average word-clarity score needed in the lesson test
const GOOD = 70;             // a word at or above this clarity score is shown green          // consecutive lessons mastered with >= 90% (1st or 2nd attempt) before the session gets longer
const LESSONS_PER_LEVEL = 36;
const CACHE = 'sitetalk-v1';
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const qs = new URLSearchParams(location.search);
const TEST_MODE = qs.has('testmode');

// ---------- state ----------
const KEY = 'sitetalk.state.v1';
const DEFAULT = {
  level: 0, lessonNum: 1, status: 'new', attempts: 0, sessionDone: false, failed: [],
  passedInLevel: 0, minutesIdx: 0, streak: 0,
  levelTest: { status: 'none', attempts: 0, weak: [] },
  model: 'base', showAr: true, history: [], done: false,
  // v2: course plan, two ways per lesson, spaced review, mistakes, site missions
  ways: { A: null, B: null }, sched: structuredClone(C.DEFAULT_SCHED), courseStart: null,
  srs: {}, mistakes: { words: {}, grammar: {} }, mission: null, xp: 0, days: [], unit: { due: false, attempts: 0, n: 0 },
};
let S = load();
// migrate v1 progress: a finished session counts as Way 1 already done
if (S.sessionDone && !S.ways.A) { S.ways.A = '2000-01-01'; }
if (!S.courseStart) { const n = C.nextClasses(S.sched, new Date(), 6).find(x => x.kind === 'new' && x.date > new Date()); S.courseStart = C.ymd(n ? n.date : new Date()); }
const todayStr = () => C.ymd(new Date());
function award(xp) { S.xp = (S.xp || 0) + xp; const t = todayStr(); if (!S.days.includes(t)) { S.days.push(t); S.days = S.days.slice(-400); } save(); }
function dayStreak() { let n = 0; const d = new Date(); for (;;) { const k = C.ymd(d); if (S.days.includes(k)) n++; else if (n || k !== todayStr()) break; d.setDate(d.getDate() - 1); if (n > 400) break; } return n; }
const way2Open = () => !!S.ways.A && S.ways.A < todayStr();     // a night's sleep between Way 1 and Way 2
const testOpen = () => !!S.ways.A && !!S.ways.B;
function load() { try { return Object.assign(structuredClone(DEFAULT), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return structuredClone(DEFAULT); } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('تعذر حفظ التقدم على الجهاز'); } }
const minutes = () => MINUTE_STEPS[S.minutesIdx];
const lessonId = (lv = S.level, n = S.lessonNum) => `${LEVEL_NAMES[lv]}-${String(n).padStart(2, '0')}`;
function log(type, extra) { S.history.unshift({ d: new Date().toISOString().slice(0, 16).replace('T', ' '), type, id: lessonId(), ...extra }); S.history = S.history.slice(0, 400); save(); }

// ---------- data ----------
let DATA, AIDX, SOUNDS;
async function loadData() {
  const [d, a, s] = await Promise.all(['data/lessons.json', 'data/audio_index.json', 'data/sounds.json'].map(u => fetch(u).then(r => r.json())));
  DATA = d; AIDX = a; SOUNDS = s;
  setNames([...d.lessons, ...d.tests].map(x => x.eng?.name).filter(Boolean));
}
const lesson = (id = lessonId()) => DATA.lessons.find(l => l.id === id);
const levelTest = (lv, ver) => DATA.tests.find(t => t.level === lv && t.version === ver);

// ---------- speech speed (rises inside each level and from level to level, same as the recordings) ----------
const SPEED_RANGE = [[0.82, 0.88], [0.88, 0.94], [0.94, 1.00], [1.00, 1.06]];
function speedOf(id) { const m = String(id).match(/^(B1\+?|B2\+?)-(\d+)$/); if (!m) return null; const lv = LEVEL_NAMES.indexOf(m[1]), [lo, hi] = SPEED_RANGE[lv]; return lo + (hi - lo) * (+m[2] - 1) / 35; }
const RATE_OPTS = [[0.8, '🐢 أبطأ'], [0.9, 'أبطأ شوية'], [1, 'سرعة الدرس']];
function rateBar() { return `<div class="toggle">${RATE_OPTS.map(([r, l]) => `<button class="btn ${(S.rate || 1) === r ? 'primary' : ''}" data-rate="${r}">${l}</button>`).join('')}</div>`; }
function bindRate() { view.querySelectorAll('[data-rate]').forEach(b => b.onclick = () => { S.rate = +b.dataset.rate; save(); view.querySelectorAll('[data-rate]').forEach(x => x.classList.toggle('primary', x === b)); }); }

// ---------- audio playback ----------
let actx; const buffers = new Map(); let curSrc = null;
function ctx() { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); return actx; }
async function pack(name) {
  if (buffers.has(name)) return buffers.get(name);
  const r = await fetch(`audio/${name}.ogg`);
  if (!r.ok) throw new Error('audio missing ' + name);
  const b = await ctx().decodeAudioData(await r.arrayBuffer());
  buffers.set(name, b); return b;
}
function segDur(name, key) { const s = AIDX[name]?.seg?.[key]; return s ? s[1] - s[0] : 2; }
function hasAudio(name) { return !!AIDX[name]; }
function stopAudio() { if (curSrc) { try { curSrc.onended = null; curSrc.stop(); } catch {} curSrc = null; } }
async function play(name, key) {
  stopAudio();
  const seg = AIDX[name]?.seg?.[key];
  if (!seg) { await speakFallback(name, key); return; }
  const b = await pack(name);
  return new Promise(res => {
    const src = ctx().createBufferSource(); src.buffer = b; src.connect(ctx().destination);
    const rt = name === 'SOUNDS' ? 1 : (S.rate || 1); src.playbackRate.value = rt;
    src.onended = () => { if (curSrc === src) curSrc = null; res(); };
    curSrc = src; src.start(0, seg[0], seg[1] - seg[0]);
  });
}
// If a lesson's recorded audio isn't ready yet, use the phone's own voice.
function speakFallback(name, key) {
  let L = DATA.lessons.find(l => l.id === name), text = '';
  const tm = name.match(/^TEST-(\d)-(\d)$/); if (tm) L = levelTest(+tm[1], +tm[2]);
  if (name === 'SOUNDS') { const [si, pi, wi] = key.slice(1).split('_').map(Number); text = SOUNDS[si]?.pairs[pi]?.[wi] || ''; }
  else if (L) {
    const m = key.match(/^([a-z]+)(\d+)$/); const i = m ? +m[2] : 0;
    text = { d: L.dialogue[i]?.[1], p: L.phrases?.[i]?.[0], h: L.hard?.[i]?.[0], r: L.read[i], rs: L.read[i], m: L.tasks[i]?.model }[m?.[1]] || '';
  }
  if (!text || !('speechSynthesis' in window)) return Promise.resolve();
  return new Promise(res => { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-GB'; u.rate = 0.9; u.onend = res; u.onerror = res; speechSynthesis.speak(u); });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- recording ----------
let rec = null;
async function startRec() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const c = ctx(); const src = c.createMediaStreamSource(stream);
  const proc = c.createScriptProcessor(4096, 1, 1); const chunks = [];
  proc.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(c.destination);
  rec = { stream, src, proc, chunks, sr: c.sampleRate, t0: Date.now() };
}
async function stopRec() {
  if (!rec) return new Float32Array(0);
  const { stream, src, proc, chunks, sr } = rec; rec = null;
  proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop());
  const n = chunks.reduce((s, c) => s + c.length, 0), x = new Float32Array(n); let o = 0;
  for (const c of chunks) { x.set(c, o); o += c.length; }
  return resample(x, sr, 16000);
}
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.floor(x.length * to / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) { // simple low-pass by averaging the source window, then pick
    const a = i * r, i0 = Math.floor(a), i1 = Math.min(x.length - 1, Math.floor(a + r));
    let s = 0, k = 0; for (let j = i0; j <= i1; j++) { s += x[j]; k++; } y[i] = s / k;
  }
  return y;
}
// For testing on a computer: ?testmode lets you pick an audio file instead of the microphone.
async function fileToPCM(file) {
  const b = await ctx().decodeAudioData(await file.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.ceil(b.duration * 16000), 16000);
  const s = off.createBufferSource(); s.buffer = b; s.connect(off.destination); s.start();
  return (await off.startRendering()).getChannelData(0);
}

// ---------- speech recognition (offline Whisper) ----------
let asr = null, asrLoading = null;
const MODELS = {
  base: { label: 'دقيق (base) — حوالي 160 ميجا', enc: ['models/base.en-encoder.int8.onnx'], dec: ['models/base.en-decoder.int8.onnx.part0', 'models/base.en-decoder.int8.onnx.part1'], tok: 'models/base.en-tokens.txt' },
  tiny: { label: 'خفيف وأسرع (tiny) — حوالي 100 ميجا', enc: ['models/tiny.en-encoder.int8.onnx'], dec: ['models/tiny.en-decoder.int8.onnx'], tok: 'models/tiny.en-tokens.txt' },
};
async function fetchParts(urls, onp) {
  const bufs = [];
  for (const u of urls) { const r = await fetch(u); if (!r.ok) throw new Error('missing ' + u); bufs.push(new Uint8Array(await r.arrayBuffer())); onp && onp(); }
  const n = bufs.reduce((s, b) => s + b.length, 0), out = new Uint8Array(n); let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  return out;
}
async function getASR(status) {
  if (asr) return asr;
  if (asrLoading) return asrLoading;
  asrLoading = (async () => {
    status && status('بيجهّز محلل الصوت (أول مرة بس في كل فتحة للتطبيق)…');
    const ort = await import('../vendor/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    const { Whisper } = await import('./whisper.js');
    const m = MODELS[S.model] || MODELS.base;
    const [encoder, decoder, tokensText, melfb] = await Promise.all([
      fetchParts(m.enc), fetchParts(m.dec), fetch(m.tok).then(r => r.text()), fetch('js/melfb.json').then(r => r.json())]);
    const w = new Whisper(ort); await w.load({ encoder, decoder, tokensText, melfb });
    asr = w; return w;
  })();
  try { return await asrLoading; } catch (e) { asrLoading = null; throw e; }
}
// Transcript + per-word pronunciation scores against the sentence he was meant to say.
async function analyzeSpeech(x, ref, status) {
  const w = await getASR(status);
  status && status('بيحلل نطقك كلمة كلمة…');
  if (x.length < 16000 * 0.4) return { text: '', words: [] };
  const r = await w.analyze(x.length > 16000 * 29 ? x.subarray(0, 16000 * 29) : x, ref);
  // People's and place names are spelled many ways: don't count them against pronunciation.
  if (!NAMESET) NAMESET = new Set(['hassan', 'riyadh', 'murabba', ...DATA.lessons.map(l => l.eng?.name?.toLowerCase()).filter(Boolean)]);
  const heardW = new Set(normWords(r.text));
  for (const z of r.words) { const c = z.word.toLowerCase().replace(/[^a-z]/g, ''); if ((NAMESET.has(c) && z.p >= 0.05) || (/^[A-Z]/.test(z.word.trim()) && heardW.has(c) && z !== r.words[0])) z.p = Math.max(z.p, 0.9); }
  return r;
}
let NAMESET = null;
async function transcribe(x, status) {
  const w = await getASR(status);
  status && status('بيحلل صوتك…');
  if (x.length < 16000 * 0.4) return '';
  return w.transcribe(x);
}

// ---------- helpers ----------
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, ms); }
function h(html) { view.innerHTML = html; window.scrollTo(0, 0); }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ORD = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth' };
const pretty = w => String(w).replace(/\b(\d)th\b/g, (m, d) => ORD[d] || m).replace(/\boclock\b/g, "o'clock");
// Arabic meaning of a sentence if it matches a dialogue line.
function arOf(L, en) { const n = normWords(en).join(' '); const d = L.dialogue.find(x => { const m = normWords(x[1]).join(' '); return m.includes(n) || n.includes(m); }); return d && d[2] ? `<p class="muted">${esc(d[2])}</p>` : ''; }
function speakerName(L, who) { return who === 'QS' ? 'Hassan (QS)' : `${L.eng.name} (${L.eng.role})`; }
function answerSecs() { return Math.min(90, Math.max(20, minutes() * 8)); }
function readCount() { const m = minutes(); return m < 5 ? 3 : m < 10 ? 4 : 5; }
function soundOf(L) { return (parseInt(L.id.split('-').pop(), 10) - 1) % SOUNDS.length; }

// ---------- home ----------
async function home() {
  stopAudio(); setNav('home');
  $('#topSub').textContent = `المستوى ${LEVEL_NAMES[S.level]}`;
  if (S.done) {
    return h(`<div class="card center"><div class="big">🎓</div><h1>خلّصت البرنامج كله</h1><p>نجحت في اختبار مستوى B2+ بنسبة 100%. تقدر تراجع أي درس من سجل التقدم.</p></div>${historyCard()}`);
  }
  const L = lesson();
  const levelDue = S.passedInLevel >= LESSONS_PER_LEVEL;
  const pct = Math.round(100 * S.passedInLevel / LESSONS_PER_LEVEL);
  let main;
  if (levelDue) {
    const T = levelTest(S.level, (S.levelTest.attempts % 2) + 1);
    main = `<div class="card"><h2>📝 اختبار المستوى ${LEVEL_NAMES[S.level]}</h2>
      <p>خلّصت ${LESSONS_PER_LEVEL} درس. عشان تنتقل للمستوى اللي بعده لازم تنجح في اختبار المستوى بنسبة <b>100%</b>.</p>
      ${S.levelTest.status === 'failed' ? `<p class="lock">آخر محاولة: ${esc(S.levelTest.last || '')} — راجع النقاط دي: ${esc((S.levelTest.weak || []).join('، '))}</p>` : ''}
      ${T ? `<button class="btn primary block" id="goLT">ابدأ اختبار المستوى (المحاولة ${S.levelTest.attempts + 1})</button>` : `<p class="muted">اختبار المستوى ده لسه بيتجهز وهيتضاف في تحديث قريب.</p>`}</div>`;
  } else if (!L) {
    main = `<div class="card"><h2>الدرس ${esc(lessonId())}</h2><p class="muted">الدروس دي لسه بتتجهز وهتتضاف في تحديث قريب للتطبيق. كمّل مراجعة الدروس اللي خلّصتها لحد ما توصل.</p></div>`;
  } else if (S.unit.due) {
    main = `<div class="card"><span class="pill acc">مراجعة الوحدة ${S.unit.n}</span><h2 style="margin-top:8px">🧩 اختبار الوحدة ${S.unit.n}</h2>
      <p>خلّصت 4 دروس. قبل الدرس الجديد: اختبار قصير للوحدة زي المعهد البريطاني — عبارات من الذاكرة، اختبار نطق للأصوات الصعبة، وكلام حر 4/3/2 لقياس الطلاقة.</p>
      ${S.unit.attempts ? `<p class="lock">آخر محاولة: ${esc(S.unit.last || '')}</p>` : ''}
      <button class="btn primary block" id="goUnit">ابدأ اختبار الوحدة</button></div>`;
  } else {
    const st = { new: '', failed: '<span class="pill bad">لسه ما أتقنتهوش</span>', pending: '<span class="pill acc">مستني الاختبار</span>' }[S.status] || '';
    const A = S.ways.A, B = S.ways.B;
    const wayRow = (k, done, label, note, open) => `<div class="way ${done ? 'done' : open ? 'open' : 'locked'}"><b>${done ? '✅' : open ? '▶' : '🔒'} ${label}</b><span class="muted">${note}</span></div>`;
    main = `<div class="card">
      <div class="row" style="justify-content:space-between"><span class="pill">الوحدة ${C.unitOf(S.lessonNum)} · الدرس ${S.lessonNum} من ${LESSONS_PER_LEVEL}</span>${st}</div>
      <h1 class="en" style="margin-top:8px">${esc(L.title)}</h1>
      <p>${esc(L.title_ar)}</p>
      <p class="muted">🎯 هدف الدرس: هتقدر <span>${esc(L.tasks[0].q_ar)}</span></p>
      <p class="muted">🔊 سرعة الكلام في الدرس ده: <b>${Math.round(speedOf(L.id) * 100)}%</b> من سرعة الكلام الطبيعي — بتزيد شوية مع كل درس ومع كل مستوى لحد 106% في B2+.</p>
      ${wayRow('A', A, 'الطريقة 1: افهم وقلّد', 'حوار بالنص والترجمة، عبارات، تقليد، نطق، لعب أدوار', true)}
      ${wayRow('B', B, 'الطريقة 2: من غير نص', A && !way2Open() && !B ? 'بتتفتح بكره بعد نوم ليلة — النوم بيثبّت اللي اتعلمته' : 'استماع من غير نص، استرجاع من العربي، دور الطرف التاني، كلام حر 4/3/2', way2Open())}
      ${wayRow('T', false, 'اختبار الدرس', 'بيتفتح بعد الطريقتين', testOpen())}
      <div style="height:6px"></div>
      ${!A ? `<button class="btn primary block" id="goA">ابدأ الطريقة 1 (${minutes()} دقايق)</button>`
        : !B && way2Open() ? `<button class="btn primary block" id="goB">ابدأ الطريقة 2 (${minutes()} دقايق)</button>`
        : !B ? `<button class="btn block" id="goA">مراجعة الطريقة 1 تاني (اختياري)</button>` : `<button class="btn block" id="goB">جلسة مراجعة تانية (اختياري)</button>`}
      <div style="height:10px"></div>
      <button class="btn dark block" id="goTest" ${testOpen() ? '' : 'disabled'}>🎙️ اختبار الدرس${S.attempts ? ` (المحاولة ${S.attempts + 1})` : ''}</button>
      ${S.failed.length ? `<p class="lock">ركّز على: ${esc(S.failed.join('، '))}</p>` : ''}
      <p class="muted center">🔒 الدرس اللي بعده مقفول لحد ما تسمع وتعيد الدرس ده بالطريقتين وتنجح في اختباره.</p>
    </div>`;
  }
  h(`${banner()}${main}
  <div class="card"><h2>⚡ تدريب سريع</h2><div class="grid2">
    <button class="btn" id="goRev">🔁 مراجعة اليوم (${C.srsStats(S).due})</button>
    <button class="btn" id="goMis">📒 أخطائي (${Object.values(S.mistakes.words).filter(w => !w.fixed).length + Object.keys(S.mistakes.grammar).length})</button>
    <button class="btn" id="goCar">🚗 استماع الطريق</button>
    <button class="btn" id="goBook">🦺 عبارات الموقع</button>
    <button class="btn" id="goChat">💬 محادثة تفاعلية</button>
    <button class="btn" id="goAI">🤖 محادثة حرة (AI)</button></div>
    ${S.mission ? `<p class="muted" style="margin-top:10px">🏗️ مهمة الموقع: ${esc(S.mission.text)} — <span class="en">${esc(S.mission.phrases.join(' · '))}</span></p>` : ''}</div>
  <div class="card"><h2>تقدمك</h2>
    <div class="grid2">
      <div class="stat"><b>${LEVEL_NAMES[S.level]}</b><span>المستوى</span></div>
      <div class="stat"><b>${S.passedInLevel}/${LESSONS_PER_LEVEL}</b><span>دروس أتقنتها في المستوى</span></div>
      <div class="stat"><b>${minutes()} د</b><span>مدة الجلسة الحالية</span></div>
      <div class="stat"><b>${S.streak}/${UP_AFTER}</b><span>إتقان متتالي ≥ 90% للزيادة</span></div>
      <div class="stat"><b>🔥 ${dayStreak()}</b><span>أيام تدريب متتالية</span></div>
      <div class="stat"><b>⭐ ${S.xp || 0}</b><span>نقاط</span></div>
    </div>
    <div style="margin-top:12px" class="bar"><i style="width:${pct}%"></i></div>
    <p class="muted">المدة بتبدأ دقيقتين وبتزيد لحد 30 دقيقة، بعد ${UP_AFTER} دروس ورا بعض تتقنهم بـ 90% أو أكتر من أول أو تاني محاولة. سرعة الكلام بتزيد تدريجيًا مع الدروس والمستويات.</p>
  </div>
  ${offlineCard()}
  ${historyCard()}`);
  $('#goA')?.addEventListener('click', () => session('A'));
  $('#goB')?.addEventListener('click', () => session('B'));
  $('#goUnit')?.addEventListener('click', () => unitCheck());
  $('#goRev').onclick = () => reviewNow(); $('#goMis').onclick = () => mistakesView(); $('#goCar').onclick = () => carMode(); $('#goBook').onclick = () => phrasebook();
  $('#goChat').onclick = () => { const L0 = lesson(); if (!L0) return; convoRun(L0, '', home); };
  $('#goAI').onclick = () => aiConvo();
  $('#bnPlan')?.addEventListener('click', () => planView());
  $('#goTest')?.addEventListener('click', () => lessonTest());
  $('#goLT')?.addEventListener('click', () => levelTestRun());
  $('#dl')?.addEventListener('click', () => downloadAll());
  refreshOfflineStatus();
}
function historyCard() {
  const rows = S.history.slice(0, 12).map(x => `<tr><td>${esc(x.d)}</td><td class="en">${esc(x.id)}</td><td>${esc(x.label || x.type)}</td><td>${esc(x.score ?? '')}</td></tr>`).join('');
  return `<div class="card"><h2>آخر النشاط</h2>${rows ? `<table>${rows}</table>` : '<p class="muted">لسه مفيش نشاط.</p>'}</div>`;
}

// ---------- offline download ----------
function offlineUrls() {
  const m = MODELS[S.model] || MODELS.base;
  const shell = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/scoring.js', 'js/coach.js', 'js/whisper.js', 'js/melfb.json', 'manifest.json',
    'data/lessons.json', 'data/audio_index.json', 'data/sounds.json', 'vendor/ort.wasm.min.mjs', 'vendor/ort-wasm-simd-threaded.wasm',
    'vendor/ort-wasm-simd-threaded.mjs', 'icons/icon-192.png', 'icons/icon-512.png'];
  const audio = Object.keys(AIDX).map(n => `audio/${n}.ogg`);
  return { shell, audio, model: [...m.enc, ...m.dec, m.tok] };
}
function offlineCard() {
  return `<div class="card"><h2>📶 الاستخدام من غير نت</h2><p id="offStat" class="muted">بيحسب…</p>
    <div class="bar"><i id="offBar"></i></div><div style="height:10px"></div>
    <button class="btn block" id="dl">نزّل كل حاجة على الموبايل (مرة واحدة على الواي فاي)</button></div>`;
}
async function refreshOfflineStatus() {
  const el = $('#offStat'); if (!el || !('caches' in window)) { if (el) el.textContent = 'المتصفح ده مايدعمش التخزين أوفلاين.'; return; }
  const c = await caches.open(CACHE); const u = offlineUrls(); const all = [...u.shell, ...u.audio, ...u.model];
  let have = 0; for (const x of all) if (await c.match(x)) have++;
  el.textContent = have === all.length ? '✅ كل حاجة متنزلة. التطبيق يشتغل من غير نت.' : `متنزل ${have} من ${all.length} ملف.`;
  const b = $('#offBar'); if (b) b.style.width = `${Math.round(100 * have / all.length)}%`;
}
async function downloadAll() {
  if (!('caches' in window)) return toast('المتصفح ده مايدعمش التخزين أوفلاين');
  try { await navigator.storage?.persist?.(); } catch {}
  const c = await caches.open(CACHE); const u = offlineUrls(); const all = [...u.shell, ...u.audio, ...u.model];
  const btn = $('#dl'); btn.disabled = true; let i = 0, fails = 0;
  for (const x of all) {
    i++; $('#offStat').textContent = `بينزّل ${i} من ${all.length}…`; $('#offBar').style.width = `${Math.round(100 * i / all.length)}%`;
    if (await c.match(x)) continue;
    try { const r = await fetch(x, { cache: 'reload' }); if (r.ok) await c.put(x, r); else fails++; } catch { fails++; }
  }
  btn.disabled = false;
  toast(fails ? `فيه ${fails} ملف ماتنزلش، جرّب تاني` : 'تم التنزيل ✅');
  refreshOfflineStatus();
}

// ---------- session planning ----------
function estimate(step, L) {
  const id = L.id, dl = L.dialogue.length;
  const dsum = L.dialogue.reduce((s, _, i) => s + segDur(id, 'd' + i), 0);
  const qsum = L.dialogue.reduce((s, d, i) => s + (d[0] === 'QS' ? segDur(id, 'd' + i) : 0), 0);
  const esum = dsum - qsum;
  return {
    listen: dsum + dl * 0.6 + 10, listen2: dsum + dl * 0.6 + 8,
    phrases: L.phrases.reduce((s, _, i) => s + segDur(id, 'p' + i) * 3 + 5, 0),
    shadow: L.dialogue.reduce((s, _, i) => s + segDur(id, 'd' + i) * 2.4 + 1.2, 0),
    sound: 30, hard: 25,
    roleQS: esum + qsum * 2.2 + (dl / 2) * 9, roleENG: qsum + esum * 2.2 + (dl / 2) * 9,
    shadowCheck: L.dialogue.reduce((s, _, i) => s + segDur(id, 'd' + i) * 2.2 + 9, 0),
    tasks: L.tasks.reduce((s, _, i) => s + segDur(id, 'm' + i) + answerSecs() + 15, 0),
    warmup: 40 + Math.min(5, C.srsDue(S, 5).length) * 15, retrieve: L.phrases.length * 15,
    fluency432: answerSecs() * 2.25 + 45, mission: 25, convo: dsum * 1.6 + qsum * 2 + L.tasks.length * (answerSecs() + 20),
  }[step];
}
const WAYS = {
  A: { first: ['warmup', 'listen', 'phrases', 'shadow', 'sound', 'hard', 'roleQS'], must: ['warmup', 'listen'], cycle: ['shadowCheck', 'roleQS', 'phrases'] },
  B: { first: ['listen2', 'convo', 'retrieve', 'roleENG', 'tasks', 'fluency432', 'mission'], must: ['listen2', 'convo', 'mission'], cycle: ['shadowCheck', 'retrieve', 'roleENG', 'tasks'] },
};
function planSession(L, way = 'A') {
  const target = minutes() * 60, W = WAYS[way];
  const plan = []; let t = 0;
  for (const s of W.first) {
    const e = estimate(s, L);
    if (!W.must.includes(s)) { if (plan.length && t >= target * 0.9) continue; if (plan.length && t + e > target * 1.15) continue; }
    plan.push(s); t += e;
  }
  // keep the closing step last
  if (plan.includes('mission')) { plan.splice(plan.indexOf('mission'), 1); }
  let k = 0;
  while (t < target * 0.9 && k < 60) { const s = W.cycle[k % W.cycle.length]; plan.push(s); t += estimate(s, L); k++; }
  if (way === 'B') plan.push('mission');
  return { plan, est: Math.round(t / 60 * 10) / 10 };
}
const STEP_AR = { listen: 'اسمع الحوار بالنص والترجمة', listen2: 'اسمع من غير ما تبص على النص', phrases: 'العبارات المهمة', shadow: 'كرر ورا كل جملة (shadowing)', sound: 'صوت الدرس', hard: 'كلمات صعبة النطق', roleQS: 'لعب أدوار: إنت حسن', roleENG: 'لعب أدوار: إنت الطرف التاني', shadowCheck: 'كرر وسجّل كل جملة', tasks: 'تدريب الموقفين',
  warmup: 'تسخين: مراجعة من الذاكرة', retrieve: 'استرجاع: قولها بالإنجليزي من العربي', fluency432: 'طلاقة 4/3/2: نفس الكلام في وقت أقل', mission: 'مهمة الموقع', convo: 'محادثة تفاعلية مع الشخصية' };

// ---------- session ----------
let sessionAbort = false, curWay = 'A';
async function session(way = 'A') {
  const L = lesson(); const { plan, est } = planSession(L, way); sessionAbort = false; curWay = way;
  let idx = 0;
  const next = async () => {
    stopAudio();
    if (idx >= plan.length) return sessionEnd(L, way);
    const step = plan[idx];
    const header = `<div class="row" style="justify-content:space-between"><span class="pill">${idx + 1} / ${plan.length}</span><span class="muted">حوالي ${est} دقيقة</span></div>
      <div class="steps">${plan.map((_, i) => `<i class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"></i>`).join('')}</div>
      <p class="muted" style="margin:0">${way === 'A' ? 'الطريقة 1: افهم وقلّد' : 'الطريقة 2: من غير نص'}</p><h2>${STEP_AR[step]}</h2>`;
    idx++;
    await STEPS[step](L, header, next);
  };
  next();
}
function nextBtn(label = 'التالي ←') { return `<div style="height:12px"></div><button class="btn primary block" id="next">${label}</button>`; }
function linesHTML(L, mode = '') {
  return `<div class="toggle"><button class="btn" id="tAr">${S.showAr ? 'إخفاء الترجمة' : 'إظهار الترجمة'}</button></div>
  <div class="lines ${S.showAr ? '' : 'hide-ar'} ${mode}" id="lines">${L.dialogue.map((d, i) => `
    <div class="line ${d[0] === 'QS' ? 'qs' : 'eng'}" data-i="${i}"><div class="who en">${esc(speakerName(L, d[0]))}</div>
    <span class="en">${esc(d[1])}</span><span class="ar">${esc(d[2] || '')}</span></div>`).join('')}</div>`;
}
function bindAr() {
  $('#tAr')?.addEventListener('click', () => { S.showAr = !S.showAr; save(); $('#lines').classList.toggle('hide-ar', !S.showAr); $('#tAr').textContent = S.showAr ? 'إخفاء الترجمة' : 'إظهار الترجمة'; });
  view.querySelectorAll('.line').forEach(el => el.addEventListener('click', () => play(currentLessonId, 'd' + el.dataset.i)));
}
let currentLessonId = '';
function mark(i) { view.querySelectorAll('.line').forEach(el => el.classList.toggle('now', +el.dataset.i === i)); const el = view.querySelector(`.line[data-i="${i}"]`); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }

const STEPS = {
  async listen(L, header, next) {
    currentLessonId = L.id;
    h(`<div class="card">${header}<p class="muted">${esc(L.scene)}</p>
      <button class="btn dark block" id="pl">▶ شغّل الحوار</button>${rateBar()}${linesHTML(L)}${nextBtn()}</div>`);
    bindAr(); bindRate(); mustListen(next);
    $('#pl').onclick = async () => { for (let i = 0; i < L.dialogue.length; i++) { if (!$('#lines')) return; mark(i); await play(L.id, 'd' + i); await wait(350); } mark(-1); listened(); };
  },
  async listen2(L, header, next) {
    currentLessonId = L.id;
    h(`<div class="card">${header}<p class="muted">اسمع وحاول تفهم من غير ما تقرا. لو احتجت، اضغط "إظهار النص".</p>
      <button class="btn dark block" id="pl">▶ شغّل الحوار</button>
      <div class="toggle"><button class="btn" id="show">إظهار النص</button></div>
      <div class="hide-en hide-ar" id="wrap">${linesHTML(L).replace('class="toggle"', 'class="toggle" hidden')}</div>${nextBtn()}</div>`);
    bindAr(); $('#next').onclick = next;
    $('#show').onclick = () => { $('#wrap').className = ''; $('#lines').classList.toggle('hide-ar', !S.showAr); };
    mustListen(next);
    $('#pl').onclick = async () => { for (let i = 0; i < L.dialogue.length; i++) { if (!$('#lines')) return; mark(i); await play(L.id, 'd' + i); await wait(350); } mark(-1); listened(); };
  },
  async phrases(L, header, next) {
    h(`<div class="card">${header}<p class="muted">اسمع كل عبارة وكررها بصوت عالي مرتين.</p>
      <button class="btn dark block" id="all">▶ شغّل الكل مع وقفات التكرار</button>
      ${L.phrases.map((p, i) => `<div class="phr"><div><div class="en">${esc(p[0])}</div><div class="muted">${esc(p[1])}</div></div><button class="play" data-k="p${i}">▶</button></div>`).join('')}${nextBtn()}</div>`);
    view.querySelectorAll('.play').forEach(b => b.onclick = () => play(L.id, b.dataset.k));
    $('#next').onclick = next;
    $('#all').onclick = async () => { for (let i = 0; i < L.phrases.length; i++) { if (!$('#next')) return; for (let r = 0; r < 2; r++) { await play(L.id, 'p' + i); await wait(segDur(L.id, 'p' + i) * 1000 * 1.3 + 900); } } };
  },
  async hard(L, header, next) {
    h(`<div class="card">${header}
      ${L.hard.map((w, i) => `<div class="phr"><div><div class="en">${esc(w[0])}</div><div class="muted">${esc(w[1])}</div></div><button class="play" data-k="h${i}">▶</button></div>`).join('')}
      <p class="muted">الحروف الكبيرة (CAPS) هي المقطع اللي بنضغط عليه.</p>${nextBtn()}</div>`);
    view.querySelectorAll('.play').forEach(b => b.onclick = () => play(L.id, b.dataset.k));
    $('#next').onclick = next;
  },
  async sound(L, header, next) {
    const si = soundOf(L), s = SOUNDS[si];
    h(`<div class="card">${header}<h3 class="en">${esc(s.name)}</h3><p>${esc(s.ar)}</p>
      ${s.pairs.map((p, pi) => `<div class="phr">${p.map((w, wi) => `<button class="btn small en" data-k="s${si}_${pi}_${wi}">${esc(w)}</button>`).join('<span class="muted">↔</span>')}</div>`).join('')}
      <button class="btn dark block" id="all">▶ شغّل الكل وكرر بعد كل كلمة</button>${nextBtn()}</div>`);
    view.querySelectorAll('[data-k]').forEach(b => b.onclick = () => play('SOUNDS', b.dataset.k));
    $('#next').onclick = next;
    $('#all').onclick = async () => { for (const b of view.querySelectorAll('[data-k]')) { if (!$('#next')) return; b.classList.add('primary'); await play('SOUNDS', b.dataset.k); await wait(1600); b.classList.remove('primary'); } };
  },
  async shadow(L, header, next) {
    currentLessonId = L.id;
    h(`<div class="card">${header}<p class="muted">هيشغّل كل جملة وبعدها وقفة: كررها بصوت عالي بنفس السرعة والنغمة.</p>
      <button class="btn dark block" id="go">▶ ابدأ</button><p class="center big" id="cue"></p>${linesHTML(L)}${nextBtn()}</div>`);
    bindAr(); $('#next').onclick = next;
    $('#go').onclick = async () => {
      for (let i = 0; i < L.dialogue.length; i++) {
        if (!$('#lines')) return; mark(i); $('#cue').textContent = '👂';
        await play(L.id, 'd' + i); $('#cue').textContent = '🗣️ كرر';
        await wait(segDur(L.id, 'd' + i) * 1000 * 1.4 + 1000);
      }
      $('#cue').textContent = '✅'; mark(-1);
    };
  },
  shadowCheck(L, header, next) { return roleplay(L, header, next, 'ALL'); },
  async warmup(L, header, next) { return warmupStep(L, header, next); },
  async retrieve(L, header, next) {
    return recallRun(L.phrases.map((p, i) => ({ en: p[0], ar: p[1], id: L.id, k: 'p' + i })), header, next, false);
  },
  async fluency432(L, header, next) { return fluencyRun(L.tasks[0], header, next); },
  async convo(L, header, next) { return convoRun(L, header, next); },
  async mission(L, header, next) {
    const ph = L.phrases.slice(0, 2).map(p => p[0]);
    h(`<div class="card">${header}<p>🏗️ قبل الحصة الجاية، استخدم الكلام ده <b>مع شخص حقيقي في الموقع</b> (فورمان، مساح، استشاري، سواق):</p>
      <p class="en" style="font-size:18px;font-weight:600">${ph.map(esc).join('<br>')}</p>
      <p class="muted">الموقف: ${esc(L.tasks[0].q_ar)}</p>
      <p class="muted">حدّد من دلوقتي: "لما أقابل ____ الساعة ____ هقول له ____". التحديد ده بيضاعف احتمال إنك تنفّذ.</p>
      <input id="plan" placeholder="لما أقابل… هقول…" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);font-family:inherit">
      ${nextBtn('تمام ←')}</div>`);
    $('#next').onclick = () => { S.mission = { id: L.id, phrases: ph, text: $('#plan').value.trim() || L.tasks[0].q_ar, set: todayStr(), checked: false }; save(); next(); };
  },
  roleQS(L, header, next) { return roleplay(L, header, next, 'QS'); },
  roleENG(L, header, next) { return roleplay(L, header, next, 'ENG'); },
  async tasks(L, header, next) {
    let i = 0;
    const show = () => {
      const t = L.tasks[i];
      h(`<div class="card">${header}<p class="pill">الموقف ${i + 1} من ${L.tasks.length}</p>
        <p class="en" style="font-size:18px;font-weight:600">${esc(t.q)}</p><p>${esc(t.q_ar)}</p>
        <p class="muted">اتكلم حوالي ${answerSecs()} ثانية. حاول تستخدم: <span class="en">${esc(t.keys.join(' · '))}</span></p>
        ${recBlock()}<div id="res"></div>
        <details><summary>إجابة نموذجية</summary><p class="en">${esc(t.model)}</p><button class="btn small" id="pm">▶ اسمعها</button></details>
        ${nextBtn(i + 1 < L.tasks.length ? 'الموقف التالي ←' : 'التالي ←')}</div>`);
      $('#pm').onclick = () => play(L.id, 'm' + i);
      bindRec(async (x, heard) => {
        const f = fluency(x, 16000, normWords(heard).length); const g = gradeTask(t, heard, f, answerSecs());
        $('#res').innerHTML = taskFeedback(g, heard, f) + `<p class="muted">قارن بالإجابة النموذجية تحت، وبعدين سجّل تاني وحاول تستخدم عبارة زيادة.</p>`;
      });
      $('#next').onclick = () => { i++; if (i < L.tasks.length) show(); else next(); };
    };
    show();
  },
};

async function roleplay(L, header, next, me) {
  currentLessonId = L.id;
  const mine = d => me === 'ALL' || d[0] === me;
  const note = me === 'ALL' ? 'اسمع كل جملة، وبعدين سجّلها بصوتك وشوف الكلمات اللي اتفهمت.' :
    me === 'QS' ? 'التطبيق بيقول جمل الطرف التاني، وإنت تقول جمل حسن وتسجّلها.' : `إنت بتلعب دور ${esc(L.eng.name)}، والتطبيق بيقول جمل حسن.`;
  let i = 0;
  h(`<div class="card">${header}<p class="muted">${note}</p>${linesHTML(L)}
    <div class="card" style="position:sticky;bottom:8px;margin-top:12px" id="panel"></div>${nextBtn('خلّصت ←')}</div>`);
  bindAr(); $('#next').onclick = next;
  const step = async () => {
    if (!$('#panel')) return;
    if (i >= L.dialogue.length) { $('#panel').innerHTML = '<p class="center">✅ خلّصت الحوار. تقدر تعيده أو تكمّل.</p><button class="btn block" id="again">↺ من الأول</button>'; $('#again').onclick = () => { i = 0; step(); }; mark(-1); return; }
    const d = L.dialogue[i]; mark(i);
    if (!mine(d) || me === 'ALL') {
      $('#panel').innerHTML = `<p class="center muted">${mine(d) ? '👂 اسمع' : '👂 الطرف التاني بيتكلم'}</p>`;
      await play(L.id, 'd' + i);
      if (!mine(d)) { i++; await wait(300); return step(); }
    }
    $('#panel').innerHTML = `<p class="center">🎙️ دورك: قول الجملة</p><p class="en center" style="font-size:18px">${esc(d[1])}</p><p class="center muted">${esc(d[2] || '')}</p>${recBlock(true)}<div id="res"></div>
      <div class="row" style="justify-content:center"><button class="btn small" id="hear">▶ اسمعها</button><button class="btn small" id="skip">تخطّي ←</button></div>`;
    $('#hear').onclick = () => play(L.id, 'd' + i);
    $('#skip').onclick = () => { i++; step(); };
    bindRec(async (x, heard, pw) => {
      const a = align(d[1], heard); noteWords(a.problems, L.id); award(2);
      $('#res').innerHTML = lineFeedback(a, heard, pw) + `<div class="row" style="justify-content:center"><button class="btn small primary" id="cont">كمّل ←</button></div>`;
      $('#cont').onclick = () => { i++; step(); };
    }, () => d[1]);
  };
  step();
}

function recBlock(compact) {
  return `<div class="center" style="margin:${compact ? 6 : 14}px 0">
    <button class="rec" id="rec">🎙️</button><p class="muted" id="recSt">اضغط وسجّل، واضغط تاني لما تخلّص</p>
    ${TEST_MODE ? '<input type="file" id="recFile" accept="audio/*">' : ''}</div>`;
}
function bindRec(onDone, refFn) {
  const b = $('#rec'), st = $('#recSt'); let on = false, timer;
  const finish = async (x) => {
    try {
      let heard, pw = null;
      if (refFn) { const r = await analyzeSpeech(x, refFn(), m => st.textContent = m); heard = r.text; pw = r.words; }
      else heard = await transcribe(x, m => st.textContent = m);
      lastPCM = x;
      st.innerHTML = 'اضغط عشان تسجّل تاني · <button class="btn small" id="mine">🔊 اسمع صوتك</button>';
      $('#mine').onclick = () => playPCM(lastPCM);
      await onDone(x, heard, pw);
    } catch (e) { console.error(e); st.textContent = 'تعذر تحليل الصوت: ' + (e.message || e) + ' — اتأكد إن ملفات التحليل متنزلة.'; }
  };
  b.onclick = async () => {
    if (!on) {
      try { stopAudio(); await startRec(); } catch (e) { st.textContent = 'محتاج إذن الميكروفون من إعدادات المتصفح.'; return; }
      on = true; b.classList.add('on'); b.textContent = '■'; const t0 = Date.now();
      timer = setInterval(() => st.textContent = `بيسجّل… ${Math.round((Date.now() - t0) / 1000)} ث`, 500);
    } else {
      on = false; clearInterval(timer); b.classList.remove('on'); b.textContent = '🎙️'; b.disabled = true;
      const x = await stopRec(); await finish(x); b.disabled = false;
    }
  };
  const f = $('#recFile'); if (f) f.onchange = async () => { b.disabled = true; await finish(await fileToPCM(f.files[0])); b.disabled = false; f.value = ''; };
}
let lastPCM = null;
function playPCM(x) {
  if (!x || !x.length) return; stopAudio();
  const b = ctx().createBuffer(1, x.length, 16000); b.copyToChannel(x, 0);
  const src = ctx().createBufferSource(); src.buffer = b; src.connect(ctx().destination); curSrc = src; src.start();
}
const pronOf = pw => pw && pw.length ? Math.round(100 * pw.reduce((s, w) => s + w.p, 0) / pw.length) : null;
function lineFeedback(a, heard, pw) {
  let words;
  if (pw && pw.length) {
    words = pw.map(w => { const sc = Math.round(w.p * 100), cls = sc >= GOOD ? 'w-ok' : sc >= 40 ? 'w-mid' : 'w-bad';
      const clean = w.word.replace(/[^A-Za-z0-9'\-]/g, '');
      return `<span class="${cls}" ${sc < GOOD ? `data-w="${esc(clean)}"` : ''}>${esc(w.word)}<sub>${sc}</sub></span>`; });
  } else {
    words = []; for (const o of a.ops) { if (o.t === 'ok') words.push(`<span class="w-ok">${esc(pretty(o.r))}</span>`); else if (o.t === 'miss') words.push(`<span class="w-bad" data-w="${esc(pretty(o.r))}">${esc(pretty(o.r))}</span>`); }
  }
  const pr = pronOf(pw), weak = (pw || []).filter(w => w.p * 100 < GOOD).sort((a, b) => a.p - b.p);
  if (pw) notePron(pw);
  return `<p class="en center pw">${words.join(' ')}</p>
    <p class="center"><span class="pill ${a.accuracy === 100 ? 'ok' : 'bad'}">${a.matched}/${a.target} كلمة اتفهمت</span>
    ${pr !== null ? ` <span class="pill ${pr >= PRON_PASS ? 'ok' : pr >= 50 ? 'acc' : 'bad'}">النطق ${pr}/100</span>` : ''}</p>
    <p class="muted center">اللي اتسمع: <span class="en">${esc(heard || '—')}</span></p>
    ${weak.length ? `<div class="fix"><b>🗣️ تصحيح النطق</b>${weak.slice(0, 3).map(w => { const c = w.word.replace(/[^A-Za-z']/g, ''); return `<p><b class="en">${esc(c)}</b> — ${Math.round(w.p * 100)}/100<br><span class="muted">${C.pronTips(c).map(esc).join('<br>')}</span></p>`; }).join('')}
      <p class="muted">👆 اضغط على أي كلمة ملوّنة عشان تسمعها بالبطيء وتسجّلها لوحدها لحد ما تبقى خضرا.</p></div>`
      : (a.problems.length ? '<p class="muted center">👆 اضغط على الكلمة الحمرا عشان تسمعها وتتدرب عليها لوحدها.</p>' : (pr !== null ? '<p class="center">🌟 نطق واضح لكل الكلمات</p>' : ''))}`;
}
function taskFeedback(g, heard, f, model) {
  const r = C.recast(heard); noteGrammar(r.fixes); award(3);
  return `<p class="muted">اللي اتسمع: <span class="en">${esc(heard || '—')}</span></p>
    ${r.fixes.length ? `<div class="fix"><b>✍️ تصحيح اللغة</b>${r.fixes.map(x => `<p>❌ <span class="en">${esc(x.wrong)}</span> ← ✅ <b class="en">${esc(x.right)}</b><br><span class="muted">${esc(x.ar)}</span></p>`).join('')}
      <p>✅ قولها كده: <span class="en">${esc(r.text)}</span></p></div>` : (normWords(heard).length >= 5 ? '<p>✍️ ماشفتش أخطاء قواعد شائعة في كلامك 👍</p>' : '')}
    <p>${g.onTopic ? '✅' : '❌'} عبارات الدرس: ${g.keys.length ? `<span class="en">${esc(g.keys.join(', '))}</span>` : 'ولا واحدة'}</p>
    <p>${g.longEnough ? '✅' : '❌'} الطول: ${g.words} كلمة (المطلوب ${g.minWords} على الأقل)</p>
    <p>⏱️ السرعة: ${f.wpm} كلمة/دقيقة · وقفات طويلة: ${f.longPauses}</p>`;
}

function sessionEnd(L, way = 'A') {
  if (!S.ways[way]) S.ways[way] = todayStr();
  S.sessionDone = !!(S.ways.A && S.ways.B); if (S.status === 'new' && S.sessionDone) S.status = 'pending';
  award(way === 'A' ? 25 : 35); log('session', { label: `${way === 'A' ? 'الطريقة 1' : 'الطريقة 2'} · ${minutes()} د` });
  if (way === 'A') {
    return h(`<div class="card center"><div class="big">👏</div><h2>خلّصت الطريقة 1</h2>
      <p>الطريقة 2 (نفس الدرس بأسلوب مختلف من غير نص) بتتفتح <b>بكره</b> في حصة ${esc(S.sched.time)}. نومك بين الطريقتين بيثبّت العبارات في الذاكرة طويلة المدى.</p>
      <p class="muted">بكره الصبح في العربية: افتح "🚗 استماع الطريق" واسمع الحوار من غير ما تبص.</p>
      <button class="btn primary block" id="later">الرئيسية</button></div>`), $('#later').onclick = home;
  }
  h(`<div class="card center"><div class="big">👏</div><h2>خلّصت الدرس بالطريقتين</h2>
    <p>دلوقتي اختبار الدرس: ${readCount()} جمل تقراها + موقفين تتكلم فيهم. محتاج <b>100%</b> في الجمل و<b>80%</b> إتقان على الأقل عشان الدرس اللي بعده يتفتح.</p>
    <button class="btn primary block" id="t">🎙️ ابدأ اختبار الدرس</button><div style="height:10px"></div>
    <button class="btn block" id="later">بعدين</button></div>`);
  $('#t').onclick = lessonTest; $('#later').onclick = home;
}

// ---------- lesson test ----------
async function lessonTest() {
  if (!testOpen()) { toast('الاختبار بيتفتح بعد ما تخلّص الدرس بالطريقتين'); return home(); }
  const L = lesson(); const n = readCount();
  const order = L.read.map((r, i) => i);
  // put sentences with failed words first, then the rest
  order.sort((a, b) => (S.failed.some(w => L.read[b].toLowerCase().includes(w)) ? 1 : 0) - (S.failed.some(w => L.read[a].toLowerCase().includes(w)) ? 1 : 0));
  const pick = order.slice(0, n).sort((a, b) => a - b);
  const R = { reads: [], tasks: [], pcm: [] };
  let k = 0;
  const readStep = () => {
    if (k >= pick.length) { k = 0; return taskStep(); }
    const ri = pick[k];
    h(`<div class="card"><span class="pill">اختبار الدرس · الجزء 1: القراية</span><h2 style="margin-top:8px">الجملة ${k + 1} من ${pick.length}</h2>
      <p class="en" style="font-size:20px;line-height:1.6">${esc(L.read[ri])}</p>${arOf(L, L.read[ri])}
      <div class="row"><button class="btn small" id="h1">▶ اسمعها</button><button class="btn small" id="h2">▶ ببطء</button></div>
      ${recBlock()}<div id="res"></div></div>`);
    $('#h1').onclick = () => play(L.id, 'r' + ri); $('#h2').onclick = () => play(L.id, 'rs' + ri);
    bindRec(async (x, heard, pw) => {
      const a = align(L.read[ri], heard);
      $('#res').innerHTML = lineFeedback(a, heard, pw) + `<div class="row" style="justify-content:center"><button class="btn primary" id="ok">التالي ←</button></div><p class="muted center">لو حاسس إن التسجيل مش واضح (دوشة)، سجّل تاني قبل ما تكمّل.</p>`;
      $('#ok').onclick = () => { R.reads[k] = { ri, a, heard, pr: pronOf(pw) }; R.pcm.push({ x, heard }); k++; readStep(); };
    }, () => L.read[ri]);
  };
  const taskStep = () => {
    if (k >= L.tasks.length) return grade();
    const t = L.tasks[k];
    h(`<div class="card"><span class="pill">اختبار الدرس · الجزء 2: المحادثة</span><h2 style="margin-top:8px">الموقف ${k + 1} من ${L.tasks.length}</h2>
      <p class="en" style="font-size:18px;font-weight:600">${esc(t.q)}</p><p>${esc(t.q_ar)}</p>
      <p class="muted">اتكلم حوالي ${answerSecs()} ثانية (${Math.round(answerSecs() * 0.9)} كلمة على الأقل)، واستخدم عبارات من الدرس.</p>
      ${recBlock()}<div id="res"></div></div>`);
    bindRec(async (x, heard) => {
      const f = fluency(x, 16000, normWords(heard).length); const g = gradeTask(t, heard, f, answerSecs());
      $('#res').innerHTML = taskFeedback(g, heard, f) + `<div class="row" style="justify-content:center"><button class="btn primary" id="ok">التالي ←</button><button class="btn" id="re">سجّل تاني</button></div>`;
      $('#re').onclick = () => { $('#res').innerHTML = ''; };
      $('#ok').onclick = () => { R.tasks[k] = g; R.pcm.push({ x, heard }); k++; taskStep(); };
    });
  };
  const grade = () => {
    const target = R.reads.reduce((s, r) => s + r.a.target, 0), matched = R.reads.reduce((s, r) => s + r.a.matched, 0);
    const acc = target ? Math.round(1000 * matched / target) / 10 : 0;
    let words = 0, speech = 0, lp = 0;
    for (const p of R.pcm) { const f = fluency(p.x, 16000, normWords(p.heard).length); words += normWords(p.heard).length; speech += f.speech; lp += f.longPauses; }
    const flu = { wpm: speech ? Math.round(words / speech * 60) : 0, longPauses: lp };
    const m = mastery(acc, R.tasks, flu, S.level);
    const prs = R.reads.map(r => r.pr).filter(v => v !== null && v !== undefined);
    const pron = prs.length ? Math.round(prs.reduce((a, b) => a + b, 0) / prs.length) : null;
    const pass = lessonPassed(acc, R.tasks, m) && (pron === null || pron >= PRON_PASS);
    S.attempts++;
    const problems = R.reads.flatMap(r => r.a.problems.map(p => ({ ...p, s: L.read[r.ri] })));
    noteWords(problems, L.id);
    if (pass) {
      const good = m.total >= 90 && S.attempts <= 2;
      S.streak = good ? S.streak + 1 : 0;
      let up = false;
      if (S.streak >= UP_AFTER && S.minutesIdx < MINUTE_STEPS.length - 1) { S.minutesIdx++; S.streak = 0; up = true; }
      log('lesson-test', { label: 'نجح ✅', score: `${m.total}%` });
      S.passedInLevel++; S.status = 'new'; S.attempts = 0; S.failed = []; S.sessionDone = false;
      L.phrases.forEach((_, i) => C.srsAdd(S, `${L.id}|${i}`));
      S.ways = { A: null, B: null };
      if (S.passedInLevel % C.LESSONS_PER_UNIT === 0 && S.passedInLevel < LESSONS_PER_LEVEL) S.unit = { due: true, attempts: 0, n: C.unitOf(S.passedInLevel) };
      S.lessonNum++; award(60);
      save();
      resultScreen(L, { acc, m, flu, pass, problems, tasks: R.tasks, up, pron });
    } else {
      S.streak = 0; S.status = 'failed';
      S.failed = [...new Set(problems.map(p => p.expected).filter(Boolean).map(pretty))].slice(0, 8);
      if (!R.tasks.every(t => t.onTopic)) S.failed.push('استخدام عبارات الدرس');
      if (flu.wpm < WPM_TARGET[S.level]) S.failed.push('السرعة');
      if (pron !== null && pron < PRON_PASS) S.failed.push('وضوح النطق');
      log('lesson-test', { label: 'لسه ❌', score: `${m.total}%` });
      save();
      resultScreen(L, { acc, m, flu, pass, problems, tasks: R.tasks, pron });
    }
  };
  readStep();
}
function resultScreen(L, r) {
  const t = WPM_TARGET[S.level];
  h(`<div class="card center"><div class="big">${r.pass ? '✅' : '🔁'}</div>
    <h2>${r.pass ? 'أتقنت الدرس!' : 'لسه — محتاجين نتقن النقط دي'}</h2>
    <p class="big" style="font-size:30px">درجة الإتقان ${r.m.total}%</p>
    <p class="muted">= دقة الكلمات ${r.acc}% × 0.6 (${r.m.parts.accuracy}) + الموقفين ${r.m.parts.tasks} من 25 + الطلاقة ${r.m.parts.fluency} من 15</p></div>
  <div class="card"><h3>📖 القراية: ${r.acc}% ${r.acc === 100 ? '✅' : '❌ (المطلوب 100%)'}</h3>
    ${r.problems.length ? r.problems.map(p => `<p>❌ المفروض <b class="en">${esc(pretty(p.expected))}</b> — اتسمع <span class="en">${esc(pretty(p.heard) || 'ولا حاجة')}</span><br><span class="muted en">${esc(p.s)}</span></p>`).join('') : '<p>كل الكلمات اتفهمت صح 👏</p>'}
    ${r.pron !== null && r.pron !== undefined ? `<h3>🎯 وضوح النطق: ${r.pron}/100 ${r.pron >= PRON_PASS ? '✅' : `❌ (المطلوب ${PRON_PASS})`}</h3>` : ''}
    <h3>🗣️ الموقفين</h3>${r.tasks.map((g, i) => `<p>${g.ok ? '✅' : '❌'} الموقف ${i + 1}: ${g.words} كلمة، عبارات الدرس: ${g.keys.length}</p>`).join('')}
    <h3>⏱️ الطلاقة</h3><p>${r.flu.wpm} كلمة/دقيقة (الهدف ${t}) · وقفات طويلة: ${r.flu.longPauses}</p>
    <p class="muted">التحليل آلي على الموبايل: بيقيس وضوح نطق كل كلمة (0–100)، والسرعة والوقفات، وبيصحح أخطاء القواعد الشائعة.</p>
    ${r.up ? `<p class="pill ok">⏫ أتقنت ${UP_AFTER} دروس ورا بعض — الجلسات هتبقى ${minutes()} دقايق</p>` : ''}
    ${r.pass ? (S.passedInLevel >= LESSONS_PER_LEVEL ? '<p>🎓 خلّصت 36 درس — اختبار المستوى مفتوح دلوقتي.</p>' : '<p>🔓 الدرس الجديد اتفتح.</p>') : '<p>🔒 الدرس الجديد لسه مقفول. اعمل جلسة مراجعة وأعد الاختبار وقت ما تحب.</p>'}
    <button class="btn primary block" id="back">الرئيسية</button>
    ${r.pass ? '' : '<div style="height:10px"></div><button class="btn block" id="again">أعد الاختبار دلوقتي</button>'}</div>`);
  $('#back').onclick = home; $('#again')?.addEventListener('click', lessonTest);
}

// ---------- level test ----------
async function levelTestRun() {
  const ver = (S.levelTest.attempts % 2) + 1; const T = levelTest(S.level, ver); const id = `TEST-${S.level}-${ver}`;
  const ans = { mcq: [], vocab: [] }, R = { reads: [], tasks: [], pcm: [] };
  // Shuffle option order per question (seeded by test + attempt) so the right answer's position can't be guessed.
  let seed = (S.level + 1) * 7919 + ver * 104729 + S.levelTest.attempts * 31;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const shuf = () => { const a = [0, 1, 2, 3]; for (let i = 3; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const permA = T.mcq.map(shuf), permB = T.vocab.map(shuf);
  const playAll = async () => { for (let i = 0; i < T.dialogue.length; i++) { if (!$('#lt')) return; await play(id, 'd' + i); await wait(300); } };
  let plays = 0;
  h(`<div class="card" id="lt"><span class="pill">اختبار المستوى ${LEVEL_NAMES[S.level]} · الجزء A</span><h2 style="margin-top:8px">اسمع الحوار (مرتين بالكتير) وجاوب</h2>
    <button class="btn dark block" id="pl">▶ شغّل الحوار (${2 - plays} متبقي)</button>
    <div class="mcq">${T.mcq.map((q, i) => `<p class="en"><b>A${i + 1}.</b> ${esc(q.q)}</p>${permA[i].map((oi, j) => `<label class="en"><input type="radio" name="a${i}" value="${oi}">${'abcd'[j]}) ${esc(q.opts[oi])}</label>`).join('')}`).join('')}</div>
    <h2>الجزء B: العبارات</h2>
    <div class="mcq">${T.vocab.map((q, i) => `<p class="en"><b>B${i + 1}.</b> ${esc(q.q)}</p>${permB[i].map((oi, j) => `<label class="en"><input type="radio" name="b${i}" value="${oi}">${'abcd'[j]}) ${esc(q.opts[oi])}</label>`).join('')}`).join('')}</div>
    ${nextBtn('الجزء C: القراية ←')}</div>`);
  $('#pl').onclick = async () => { if (plays >= 2) return; plays++; $('#pl').textContent = `▶ شغّل الحوار (${2 - plays} متبقي)`; if (plays >= 2) $('#pl').disabled = true; await playAll(); };
  $('#next').onclick = () => {
    for (let i = 0; i < T.mcq.length; i++) { const v = view.querySelector(`input[name=a${i}]:checked`); ans.mcq[i] = v ? +v.value : -1; }
    for (let i = 0; i < T.vocab.length; i++) { const v = view.querySelector(`input[name=b${i}]:checked`); ans.vocab[i] = v ? +v.value : -1; }
    if ([...ans.mcq, ...ans.vocab].includes(-1)) return toast('جاوب على كل الأسئلة الأول');
    stopAudio(); k = 0; readStep();
  };
  let k = 0;
  const readStep = () => {
    if (k >= T.read.length) { k = 0; return taskStep(); }
    h(`<div class="card"><span class="pill">اختبار المستوى · الجزء C</span><h2 style="margin-top:8px">الجملة ${k + 1} من ${T.read.length}</h2>
      <p class="en" style="font-size:20px">${esc(T.read[k])}</p>${recBlock()}<div id="res"></div></div>`);
    bindRec(async (x, heard) => {
      const a = align(T.read[k], heard);
      $('#res').innerHTML = `<p class="muted center">اللي اتسمع: <span class="en">${esc(heard || '—')}</span></p><div class="row" style="justify-content:center"><button class="btn primary" id="ok">التالي ←</button></div><p class="muted center">لو التسجيل فيه دوشة، سجّل تاني.</p>`;
      $('#ok').onclick = () => { R.reads[k] = a; R.pcm.push({ x, heard }); k++; readStep(); };
    }, () => T.read[k]);
  };
  const taskStep = () => {
    if (k >= T.tasks.length) return grade();
    const t = T.tasks[k];
    h(`<div class="card"><span class="pill">اختبار المستوى · الجزء D</span><h2 style="margin-top:8px">الموقف ${k + 1} من ${T.tasks.length}</h2>
      <p class="en" style="font-size:18px;font-weight:600">${esc(t.q)}</p><p>${esc(t.q_ar)}</p><p class="muted">اتكلم حوالي ${answerSecs()} ثانية.</p>${recBlock()}<div id="res"></div></div>`);
    bindRec(async (x, heard) => {
      const f = fluency(x, 16000, normWords(heard).length); const g = gradeTask(t, heard, f, answerSecs());
      $('#res').innerHTML = `<p class="muted">اللي اتسمع: <span class="en">${esc(heard || '—')}</span></p><div class="row" style="justify-content:center"><button class="btn primary" id="ok">التالي ←</button></div>`;
      $('#ok').onclick = () => { R.tasks[k] = g; R.pcm.push({ x, heard }); k++; taskStep(); };
    });
  };
  const grade = () => {
    const wrongA = T.mcq.map((q, i) => ans.mcq[i] === q.ans ? null : i).filter(x => x !== null);
    const wrongB = T.vocab.map((q, i) => ans.vocab[i] === q.ans ? null : i).filter(x => x !== null);
    const cOk = R.reads.filter(a => a.accuracy === 100).length;
    const dOk = R.tasks.filter(g => g.ok).length;
    const correct = (T.mcq.length - wrongA.length) + (T.vocab.length - wrongB.length) + cOk + dOk;
    const total = T.mcq.length + T.vocab.length + T.read.length + T.tasks.length;
    const pct = Math.round(1000 * correct / total) / 10;
    S.levelTest.attempts++;
    const weak = [...wrongA.map(i => `A${i + 1}`), ...wrongB.map(i => `B${i + 1}`), ...R.reads.flatMap(a => a.problems.map(p => pretty(p.expected)))].slice(0, 10);
    if (correct === total) {
      log('level-test', { label: `نجح مستوى ${LEVEL_NAMES[S.level]}`, score: '100%' });
      if (S.level >= 3) { S.done = true; }
      else { S.level++; S.lessonNum = 1; S.passedInLevel = 0; S.status = 'new'; S.attempts = 0; S.failed = []; S.sessionDone = false; S.levelTest = { status: 'none', attempts: 0, weak: [] }; }
      save();
      h(`<div class="card center"><div class="big">🎉</div><h2>نجحت في اختبار المستوى 100%</h2><p>${S.done ? 'خلّصت البرنامج كله.' : `اتنقلت لمستوى ${LEVEL_NAMES[S.level]}: حوارات أطول وكلام أسرع شوية.`}</p><button class="btn primary block" id="b">الرئيسية</button></div>`);
    } else {
      S.levelTest.status = 'failed'; S.levelTest.weak = weak; S.levelTest.last = `${pct}%`;
      log('level-test', { label: 'لسه ❌', score: `${pct}%` }); save();
      h(`<div class="card"><h2>🔁 النتيجة ${pct}% — المطلوب 100%</h2>
        ${wrongA.map(i => `<p>❌ A${i + 1}: الإجابة الصح <b class="en">${'abcd'[permA[i].indexOf(T.mcq[i].ans)]}) ${esc(T.mcq[i].opts[T.mcq[i].ans])}</b></p>`).join('')}
        ${wrongB.map(i => `<p>❌ B${i + 1}: الإجابة الصح <b class="en">${'abcd'[permB[i].indexOf(T.vocab[i].ans)]}) ${esc(T.vocab[i].opts[T.vocab[i].ans])}</b></p>`).join('')}
        ${R.reads.flatMap(a => a.problems).map(p => `<p>❌ نطق: المفروض <b class="en">${esc(pretty(p.expected))}</b> — اتسمع <span class="en">${esc(pretty(p.heard) || 'ولا حاجة')}</span></p>`).join('')}
        ${R.tasks.map((g, i) => g.ok ? '' : `<p>❌ الموقف ${i + 1}: ${g.words} كلمة، عبارات المستوى: ${g.keys.length}</p>`).join('')}
        <p>هتفضل في نفس المستوى. راجع النقاط دي وأعد الاختبار (هتاخد نسخة تانية من الاختبار).</p>
        <button class="btn primary block" id="b">الرئيسية</button></div>`);
    }
    $('#b').onclick = home;
  };
}

// ---------- reminders, banner ----------
function nextClassInfo() {
  const n = C.nextClasses(S.sched, new Date(), 6);
  return n.find(x => x.date > new Date());
}
function dueAction() {
  if (S.done) return null;
  if (S.unit.due) return 'اختبار الوحدة مستنيك';
  if (S.passedInLevel >= LESSONS_PER_LEVEL) return 'اختبار المستوى مستنيك';
  if (!S.ways.A) return 'ابدأ الطريقة 1 للدرس الجديد';
  if (!S.ways.B) return way2Open() ? 'الطريقة 2 لنفس الدرس (من غير نص)' : null;
  return 'اختبار الدرس';
}
function banner() {
  const n = nextClassInfo(), act = dueAction();
  const kind = { new: 'درس جديد', way2: 'الطريقة 2 + الاختبار', review: 'مراجعة الأسبوع' };
  const when = n ? `${C.DAY_AR[n.date.getDay()]} ${n.date.toTimeString().slice(0, 5)}` : '';
  return `<div class="card banner"><b>📅 الحصة الجاية: ${esc(when)}</b>${act ? `<span>👉 المطلوب منك: ${esc(act)}</span>` : (S.ways.A && !S.ways.B ? '<span>😴 الطريقة 2 بتتفتح بكره بعد نوم ليلة</span>' : '')}
    <span class="muted">🚗 في العربية 6:35 ص و6:10 م: افتح "استماع الطريق" وكرر بصوت عالي.</span></div>`;
}
async function remind(force) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date(), act = dueAction(); if (!act) return;
  const n = C.nextClasses(S.sched, now, 2).find(x => Math.abs(x.date - now) < 15 * 60e3);
  const key = n ? C.ymd(n.date) + n.kind : null;
  if (!force && (!key || S.lastNotified === key)) return;
  S.lastNotified = key; save();
  try { const r = await navigator.serviceWorker?.ready; const body = `حصة Site Talk: ${act}`;
    if (r) r.showNotification('Site Talk English', { body, icon: 'icons/icon-192.png', tag: 'class', renotify: true });
    else new Notification('Site Talk English', { body });
  } catch {}
}

// ---------- listening gate ----------
let heardAll = false;
function mustListen(next) {
  heardAll = false; const b = $('#next'); b.disabled = true; b.textContent = '🔒 اسمع الحوار للآخر الأول';
  b.onclick = next;
}
function listened() { heardAll = true; const b = $('#next'); if (b) { b.disabled = false; b.textContent = 'التالي ←'; } award(3); }

// ---------- warm-up (spaced retrieval + site mission check-in) ----------
async function warmupStep(L, header, next) {
  const items = C.srsDue(S, 5).map(srsItem).filter(Boolean);
  const m = S.mission && S.mission.id !== L.id && !S.mission.checked ? S.mission : null;
  const go = () => items.length ? recallRun(items, header + '<p class="muted">مراجعة متباعدة: العبارات دي من دروس فاتت وجه ميعاد مراجعتها.</p>', next, true) : next();
  if (!m) { if (!items.length) { h(`<div class="card">${header}<p>👍 مفيش مراجعة مستحقة النهارده. يلا على الدرس.</p>${nextBtn()}</div>`); $('#next').onclick = next; return; } return go(); }
  h(`<div class="card">${header}<p>🏗️ مهمة الموقع اللي فاتت: <b>${esc(m.text)}</b></p><p class="en">${m.phrases.map(esc).join('<br>')}</p>
    <p>استخدمت العبارات دي فعلًا مع حد في الموقع؟</p>
    <div class="row"><button class="btn primary" id="yes">✅ أيوه</button><button class="btn" id="no">لسه</button></div>
    <p class="muted">لو أيوه: سجّل نفسك وإنت بتعيد اللي قلته بالظبط.</p></div>`);
  $('#yes').onclick = () => { S.mission.checked = true; award(30); log('mission', { label: 'نفّذ مهمة الموقع ✅' }); go(); };
  $('#no').onclick = () => { toast('حاول بكره — المهمة لسه شغالة'); go(); };
}
function srsItem(key) {
  const [id, i] = key.split('|'); const L = DATA.lessons.find(l => l.id === id); const p = L?.phrases?.[+i];
  return p ? { en: p[0], ar: p[1], id, k: 'p' + i, key } : null;
}
// Arabic → say it in English (retrieval practice). srs=true grades the Leitner boxes.
function recallRun(items, header, next, srs) {
  let i = 0, tries = 0;
  const show = () => {
    if (i >= items.length) return next();
    const it = items[i];
    h(`<div class="card">${header}<span class="pill">${i + 1} / ${items.length}</span>
      <p style="font-size:20px;margin-top:10px">${esc(it.ar)}</p><p class="muted">قولها بالإنجليزي من دماغك، من غير ما تبص.</p>
      ${recBlock()}<div id="res"></div>
      <div class="row" style="justify-content:center"><button class="btn small" id="peek">👀 وريني</button></div></div>`);
    $('#peek').onclick = () => { $('#res').innerHTML = `<p class="en center" style="font-size:18px">${esc(it.en)}</p>`; play(it.id, it.k); tries = 9; };
    bindRec(async (x, heard, pw) => {
      const a = align(it.en, heard), ok = a.accuracy >= 100 || (a.accuracy >= 80 && pronOf(pw) >= 75);
      tries++;
      $('#res').innerHTML = lineFeedback(a, heard, pw) + `<p class="center">${ok ? '✅ برافو' : '❌ الصح:'} <b class="en">${esc(it.en)}</b></p>
        <div class="row" style="justify-content:center"><button class="btn small" id="pl">▶ اسمعها</button>${ok ? '' : '<button class="btn small" id="again">↺ جرّب تاني</button>'}<button class="btn small primary" id="nx">التالي ←</button></div>`;
      $('#pl').onclick = () => play(it.id, it.k);
      $('#again')?.addEventListener('click', () => { $('#res').innerHTML = ''; });
      $('#nx').onclick = () => { if (srs && it.key) srsGrade(it.key, ok && tries <= 1); if (ok) award(4); i++; tries = 0; show(); };
      if (!ok) play(it.id, it.k);
    }, () => it.en);
  };
  show();
}
function srsGrade(key, ok) { C.srsGrade(S, key, ok); save(); }

// ---------- 4/3/2 fluency (Nation): same talk three times, less time each round ----------
function fluencyRun(task, header, next, onResult) {
  const base = Math.max(30, answerSecs()); const rounds = [base, Math.round(base * 0.75), Math.round(base * 0.5)];
  const res = []; let r = 0;
  const show = () => {
    if (r >= 3) {
      const up = res[2].wpm - res[0].wpm;
      const ok = res[2].wpm >= res[0].wpm && res[2].wpm >= WPM_TARGET[S.level] * 0.8;
      h(`<div class="card">${header}<h3>نتيجة 4/3/2</h3>${res.map((x, k) => `<p>الجولة ${k + 1} (${rounds[k]} ث): ${x.wpm} كلمة/دقيقة · ${x.words} كلمة</p>`).join('')}
        <p>${up >= 0 ? `⏫ سرعتك زادت ${up} كلمة/دقيقة — ده معنى الطلاقة: نفس الأفكار أسرع وبوقفات أقل.` : 'حاول في الجولة الأخيرة تقول نفس الأفكار أسرع من غير ما تقف.'}</p>${nextBtn()}</div>`);
      award(10); onResult && onResult({ ok, res });
      return $('#next').onclick = next;
    }
    h(`<div class="card">${header}<span class="pill">الجولة ${r + 1} من 3 · ${rounds[r]} ثانية</span>
      <p class="en" style="font-size:18px;font-weight:600;margin-top:8px">${esc(task.q)}</p><p>${esc(task.q_ar)}</p>
      <p class="muted">${r === 0 ? 'اتكلم براحتك عن الموقف.' : 'قول نفس الكلام تاني في وقت أقل — أسرع وبوقفات أقل.'} التسجيل بيقف لوحده.</p>
      ${recBlock()}<div id="res"></div></div>`);
    autoStop(rounds[r]);
    bindRec(async (x, heard) => {
      const f = fluency(x, 16000, normWords(heard).length); res[r] = { wpm: f.wpm, words: normWords(heard).length };
      const fx = C.recast(heard); noteGrammar(fx.fixes);
      $('#res').innerHTML = `<p class="muted">اللي اتسمع: <span class="en">${esc(heard || '—')}</span></p><p>⏱️ ${f.wpm} كلمة/دقيقة · وقفات طويلة: ${f.longPauses}</p>
        ${fx.fixes.length ? `<div class="fix"><b>✍️ تصحيح</b>${fx.fixes.map(z => `<p>❌ <span class="en">${esc(z.wrong)}</span> ← ✅ <b class="en">${esc(z.right)}</b></p>`).join('')}</div>` : ''}
        <button class="btn primary block" id="nx">${r < 2 ? 'الجولة اللي بعدها ←' : 'النتيجة ←'}</button>`;
      $('#nx').onclick = () => { r++; show(); };
    });
  };
  show();
}
function autoStop(secs) {
  const b = $('#rec'); if (!b) return;
  b.addEventListener('click', () => { clearTimeout(b._t); if (b.classList.contains('on')) b._t = setTimeout(() => { if (b.classList.contains('on')) b.click(); }, secs * 1000); });
}

// ---------- mistakes notebook ----------
function noteWords(problems, id) {
  for (const p of problems || []) for (const w of String(p.expected || '').split(' ')) {
    if (!w || w.length < 3 || /^\d/.test(w)) continue;
    const m = S.mistakes.words[w] || (S.mistakes.words[w] = { n: 0, fixed: false, id });
    m.n++; m.fixed = false; m.last = todayStr();
  }
  save();
}
function notePron(pw) {
  for (const w of pw) {
    const c = w.word.replace(/[^A-Za-z']/g, '').toLowerCase(); if (c.length < 3 || w.p >= 0.4) continue;
    const m = S.mistakes.words[c] || (S.mistakes.words[c] = { n: 0, fixed: false }); m.n++; m.fixed = false; m.last = todayStr();
  }
  save();
}
function noteGrammar(fixes) {
  for (const f of fixes || []) { const g = S.mistakes.grammar[f.wrong] || (S.mistakes.grammar[f.wrong] = { right: f.right, ar: f.ar, n: 0 }); g.n++; g.last = todayStr(); }
  save();
}
function mistakesView() {
  stopAudio(); setNav('mis');
  const words = Object.entries(S.mistakes.words).filter(([, v]) => !v.fixed).sort((a, b) => b[1].n - a[1].n);
  const fixed = Object.entries(S.mistakes.words).filter(([, v]) => v.fixed).length;
  const gram = Object.entries(S.mistakes.grammar).sort((a, b) => b[1].n - a[1].n);
  h(`<div class="card"><h2>📒 دفتر أخطائي</h2><p class="muted">كل كلمة نطقها مش واضح وكل غلطة قواعد بتتسجل هنا تلقائي. اضغط على الكلمة عشان تتدرب عليها لحد ما تبقى خضرا وتتشال من الدفتر.</p>
    <h3>🗣️ كلمات محتاجة نطق (${words.length}) · اتصلّح ${fixed}</h3>
    <div class="chips">${words.slice(0, 60).map(([w, v]) => `<button class="chip bad" data-w="${esc(w)}">${esc(w)} <small>×${v.n}</small></button>`).join('') || '<p class="muted">مفيش 👏</p>'}</div>
    <h3>✍️ أخطاء القواعد (${gram.length})</h3>
    ${gram.slice(0, 40).map(([w, g]) => `<p>❌ <span class="en">${esc(w)}</span> ← ✅ <b class="en">${esc(g.right)}</b> <small>×${g.n}</small><br><span class="muted">${esc(g.ar)}</span></p>`).join('') || '<p class="muted">مفيش أخطاء قواعد متسجلة لسه.</p>'}
    ${gram.length ? '<button class="btn block" id="clrG">اتعلمتهم — امسح أخطاء القواعد</button>' : ''}</div>`);
  $('#clrG')?.addEventListener('click', () => { S.mistakes.grammar = {}; save(); mistakesView(); });
}

// ---------- word coach (hear slowly, tips, record just that word) ----------
function sayTTS(text, rate = 0.85) {
  if (!('speechSynthesis' in window)) return Promise.resolve();
  speechSynthesis.cancel();
  return new Promise(res => { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-GB'; u.rate = rate;
    const v = speechSynthesis.getVoices().find(v => /en-GB/i.test(v.lang)) || speechSynthesis.getVoices().find(v => /^en/i.test(v.lang)); if (v) u.voice = v;
    u.onend = res; u.onerror = res; speechSynthesis.speak(u); });
}
function wordDrill(word) {
  word = String(word).replace(/[^A-Za-z'\-]/g, ''); if (!word) return;
  stopAudio();
  const ov = document.createElement('div'); ov.className = 'overlay';
  const frame = `Say ${word} again.`;
  ov.innerHTML = `<div class="card sheet"><div class="row" style="justify-content:space-between"><h2 class="en" style="margin:0">${esc(word)}</h2><button class="btn small" id="x">✕</button></div>
    <div class="row"><button class="btn small" id="n">▶ عادي</button><button class="btn small" id="sl">🐢 بالبطيء</button><button class="btn small" id="sy">✂️ مقطع مقطع</button></div>
    <div class="fix">${C.pronTips(word).map(t => `<p>${esc(t)}</p>`).join('') || '<p>اسمعها كويس وقلّد نفس النغمة.</p>'}</div>
    <p>سجّل الجملة دي: <b class="en">${esc(frame)}</b></p>
    <div id="wrec"></div><div id="wres"></div></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); };
  ov.querySelector('#x').onclick = close; ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelector('#n').onclick = () => sayTTS(word, 0.9);
  ov.querySelector('#sl').onclick = () => sayTTS(word, 0.45);
  ov.querySelector('#sy').onclick = async () => { for (const p of word.split(/(?<=[aeiouy])(?=[^aeiouy][aeiouy])/i)) { await sayTTS(p, 0.5); await wait(250); } await sayTTS(word, 0.7); };
  // reuse the recorder inside the sheet
  const wr = ov.querySelector('#wrec'); wr.innerHTML = recBlock(true);
  bindRecIn(ov, async (x, heard, pw) => {
    const sc = pw && pw.find(w => w.word.toLowerCase().replace(/[^a-z']/g, '') === word.toLowerCase());
    const s100 = sc ? Math.round(sc.p * 100) : (normWords(heard).includes(word.toLowerCase()) ? 70 : 0);
    const ok = s100 >= 75;
    ov.querySelector('#wres').innerHTML = `<p class="center"><span class="pill ${ok ? 'ok' : s100 >= 50 ? 'acc' : 'bad'}">${esc(word)}: ${s100}/100</span></p>
      <p class="muted center">اللي اتسمع: <span class="en">${esc(heard || '—')}</span></p>
      <p class="center">${ok ? '🌟 ممتاز! الكلمة اتشالت من دفتر الأخطاء.' : 'قرّب أكتر: اسمعها بالبطيء وجرّب تاني.'}</p>`;
    const m = S.mistakes.words[word.toLowerCase()]; if (ok && m) { m.fixed = true; award(5); save(); }
    if (!ok) sayTTS(word, 0.6);
  }, () => frame);
}
// Same as bindRec but scoped to a container (the word sheet).
function bindRecIn(root, onDone, refFn) {
  const b = root.querySelector('#rec'), st = root.querySelector('#recSt'); let on = false, timer;
  b.onclick = async () => {
    if (!on) {
      try { stopAudio(); await startRec(); } catch { st.textContent = 'محتاج إذن الميكروفون.'; return; }
      on = true; b.classList.add('on'); b.textContent = '■'; const t0 = Date.now();
      timer = setInterval(() => st.textContent = `بيسجّل… ${Math.round((Date.now() - t0) / 1000)} ث`, 500);
    } else {
      on = false; clearInterval(timer); b.classList.remove('on'); b.textContent = '🎙️'; b.disabled = true;
      const x = await stopRec();
      try { const r = await analyzeSpeech(x, refFn(), m => st.textContent = m); st.textContent = 'سجّل تاني لو حابب'; await onDone(x, r.text, r.words); }
      catch (e) { st.textContent = 'تعذر التحليل: ' + (e.message || e); }
      b.disabled = false;
    }
  };
}

// ---------- review now (outside a class) ----------
function reviewNow() {
  setNav('');
  const items = C.srsDue(S, 10).map(srsItem).filter(Boolean);
  if (!items.length) { const st = C.srsStats(S); return h(`<div class="card center"><div class="big">👍</div><h2>مفيش مراجعة مستحقة دلوقتي</h2><p>عندك ${st.total} عبارة في المراجعة المتباعدة، منهم ${st.strong} ثابتين في الذاكرة. كل عبارة بترجعلك بعد 1، 2، 4، 7، 14، 30، 60 يوم.</p><button class="btn primary block" id="b">الرئيسية</button></div>`), $('#b').onclick = home; }
  recallRun(items, '<h2>🔁 مراجعة اليوم</h2>', () => { log('review', { label: `مراجعة ${items.length} عبارة` }); home(); }, true);
}

// ---------- commute mode (hands-free listening, repeat aloud) ----------
async function carMode() {
  setNav('');
  const L = lesson(); if (!L) return home();
  let stop = false, wl = null;
  h(`<div class="card center car"><h2>🚗 استماع الطريق</h2><p class="en">${esc(L.title)}</p>
    <p class="muted">من غير ما تبص على الشاشة: اسمع، وفي السكتة كرر بصوت عالي. سيب الموبايل على الحامل.</p>
    <p class="big" id="cue">▶</p><p id="what" class="en" style="font-size:20px;font-weight:600"></p><p id="whatAr" style="font-size:18px"></p>
    <label class="chip" style="margin:8px auto"><input type="checkbox" id="carAr" ${S.carAr !== false ? 'checked' : ''}> 🔊 قول الترجمة العربي بعد كل جملة</label>
    ${rateBar()}
    <button class="btn primary block" id="go">ابدأ</button><div style="height:10px"></div><button class="btn block" id="st">إيقاف</button></div>`);
  bindRate();
  $('#st').onclick = () => { stop = true; stopAudio(); try { speechSynthesis.cancel(); } catch {} try { wl?.release(); } catch {} home(); };
  $('#go').onclick = async () => {
    $('#go').disabled = true; try { wl = await navigator.wakeLock?.request('screen'); } catch {}
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: L.title, artist: 'Site Talk English' });
    S.carAr = $('#carAr').checked; save();
    const cue = (c, en, ar = '') => { if ($('#cue')) { $('#cue').textContent = c; $('#what').textContent = en; $('#whatAr').textContent = ar; } };
    const sayAr = t => S.carAr && t && 'speechSynthesis' in window ? new Promise(r => { const u = new SpeechSynthesisUtterance(t); u.lang = 'ar-EG'; u.rate = 1; const v = speechSynthesis.getVoices().find(v => /^ar/i.test(v.lang)); if (v) u.voice = v; u.onend = r; u.onerror = r; speechSynthesis.speak(u); }) : Promise.resolve();
    // 1) the dialogue twice  2) each line with a repeat gap  3) key phrases x2  4) due review phrases
    const gap = (id, k, f) => wait(segDur(id, k) * 1000 * f / (S.rate || 1) + 900);
    // round 1: each line in English, then its Arabic meaning; round 2: English only (no translation)
    for (let i = 0; i < L.dialogue.length && !stop; i++) { const d = L.dialogue[i]; cue('👂', d[1], d[2]); await play(L.id, 'd' + i); await wait(300); await sayAr(d[2]); await wait(300); }
    for (let i = 0; i < L.dialogue.length && !stop; i++) { const d = L.dialogue[i]; cue('👂', d[1], d[2]); await play(L.id, 'd' + i); await wait(400); }
    for (let i = 0; i < L.dialogue.length && !stop; i++) { const d = L.dialogue[i]; cue('👂', d[1], d[2]); await play(L.id, 'd' + i); cue('🗣️ كرر', d[1], d[2]); await gap(L.id, 'd' + i, 1.4); }
    for (let i = 0; i < L.phrases.length && !stop; i++) for (let k = 0; k < 2; k++) { const p = L.phrases[i]; cue('👂', p[0], p[1]); await play(L.id, 'p' + i); cue('🗣️ كرر', p[0], p[1]); await gap(L.id, 'p' + i, 1.5); }
    // review: Arabic first, try to say it, then hear the English
    for (const it of C.srsDue(S, 6).map(srsItem).filter(Boolean)) { if (stop) break; cue('🔁 قولها بالإنجليزي', '', it.ar); await sayAr(it.ar); await wait(3500); cue('👂', it.en, it.ar); await play(it.id, it.k); cue('🗣️ كرر', it.en, it.ar); await gap(it.id, it.k, 1.5); }
    if (!stop) { cue('✅', '', 'خلصت. كمّل بالليل في الحصة.'); award(10); log('car', { label: 'استماع الطريق' }); }
    try { wl?.release(); } catch {}
  };
}

// ---------- site phrasebook ----------
function phrasebook() {
  stopAudio(); setNav('book');
  const upto = S.level * 36 + S.lessonNum;
  const list = DATA.lessons.filter(l => C.globalIndex(l.level, +l.id.split('-').pop()) <= upto);
  const render = q => {
    q = (q || '').trim().toLowerCase();
    $('#bk').innerHTML = list.map(l => {
      const ps = l.phrases.map((p, i) => ({ p, i })).filter(({ p }) => !q || p[0].toLowerCase().includes(q) || p[1].includes(q));
      if (!ps.length) return '';
      return `<h3 class="en">${esc(l.title)} <small class="muted">${esc(l.title_ar)}</small></h3>${ps.map(({ p, i }) => `<div class="phr"><div><div class="en">${esc(p[0])}</div><div class="muted">${esc(p[1])}</div></div><button class="play" data-id="${l.id}" data-k="p${i}">▶</button></div>`).join('')}`;
    }).join('') || '<p class="muted">مفيش نتايج.</p>';
    $('#bk').querySelectorAll('.play').forEach(b => b.onclick = () => play(b.dataset.id, b.dataset.k));
  };
  h(`<div class="card"><h2>🦺 عبارات الموقع</h2><p class="muted">كل العبارات اللي اتعلمتها لحد دلوقتي، بالصوت. ابحث بالعربي أو بالإنجليزي قبل ما تكلم حد في الموقع.</p>
    <input id="q" placeholder="ابحث: level, منسوب, truck, دفعة…" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);font-family:inherit"><div id="bk"></div></div>`);
  $('#q').oninput = e => render(e.target.value); render('');
}

// ---------- course plan (British Council style) ----------
function planView() {
  stopAudio(); setNav('plan');
  const g = C.globalIndex(S.level, S.lessonNum), wk = C.weekOf(g);
  const planned = C.classesBetween(S.sched, S.courseStart) || 0, diff = (g - 1) - planned;
  const endD = C.plannedDate(S.sched, S.courseStart, C.TOTAL_LESSONS);
  const rows = []; for (let lv = 0; lv < 4; lv++) for (let u = 1; u <= C.UNITS_PER_LEVEL; u++) {
    const first = lv * 36 + (u - 1) * 4 + 1, ls = DATA.lessons.filter(l => l.level === lv).slice((u - 1) * 4, u * 4);
    const d = C.plannedDate(S.sched, S.courseStart, first); const cur = g >= first && g < first + 4, done = g >= first + 4 || S.done;
    rows.push(`<div class="unit ${cur ? 'cur' : done ? 'done' : ''}"><b>${done ? '✅' : cur ? '▶' : '○'} ${LEVEL_NAMES[lv]} · الوحدة ${u}</b> <small class="muted">${d ? d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }) : ''}</small>
      <div class="muted en" style="font-size:13px">${ls.map(l => esc(l.title)).join(' · ')}</div></div>`);
    if (u === C.UNITS_PER_LEVEL) rows.push(`<div class="unit test"><b>📝 اختبار المستوى ${LEVEL_NAMES[lv]} (100%)</b><div class="muted">${C.CAN_DO[lv].map(esc).join(' · ')}</div></div>`);
  }
  h(`<div class="card"><h2>🗓️ خطة الكورس</h2>
    <p>4 مستويات (B1 → B2+) · 36 وحدة · 144 درس · حوالي ${C.TOTAL_WEEKS} أسبوع (${Math.round(C.TOTAL_WEEKS / 4.3)} شهر). النهاية المتوقعة: <b>${endD ? endD.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</b></p>
    <div class="grid2"><div class="stat"><b>${wk}/${C.TOTAL_WEEKS}</b><span>الأسبوع</span></div><div class="stat"><b>${diff >= 0 ? '✅' : '⏳'} ${Math.abs(diff)}</b><span>${diff >= 0 ? 'دروس قدّام الخطة' : 'دروس متأخر عن الخطة'}</span></div></div>
    <h3>📆 الجدول الأسبوعي (مبني على علم التعلّم)</h3>
    <table>
      <tr><td>🚗 6:35 ص و6:10 م (كل يوم شغل)</td><td>استماع الطريق 10–15 د: اسمع وكرر بصوت عالي</td></tr>
      <tr><td>${S.sched.days.map(d => C.DAY_AR[d]).join(' / ')} ${esc(S.sched.time)}</td><td>درس جديد — الطريقة 1: افهم وقلّد</td></tr>
      <tr><td>${C.way2Days(S.sched).map(d => C.DAY_AR[d]).join(' / ')} ${esc(S.sched.time)}</td><td>نفس الدرس — الطريقة 2: من غير نص + الاختبار</td></tr>
      <tr><td>في الموقع</td><td>مهمة الموقع: استخدم عبارتين مع شخص حقيقي</td></tr>
      <tr><td>الجمعة</td><td>راحة + مراجعة أسبوعية 15 د (دفتر الأخطاء)</td></tr>
    </table>
    <details><summary>ليه الجدول ده؟</summary>
      <p>• <b>التكرار المتباعد</b>: الطريقة 2 بعد نوم ليلة، والعبارات بترجعلك بعد 1، 2، 4، 7، 14، 30، 60 يوم — ده أقوى طريقة لتثبيت الذاكرة.</p>
      <p>• <b>النوم بيثبّت</b>: المذاكرة بالليل قبل النوم والمراجعة تاني يوم بتحسن الحفظ.</p>
      <p>• <b>الاسترجاع</b>: إنك تطلّع العبارة من دماغك (من العربي للإنجليزي) أقوى من إعادة القراية.</p>
      <p>• <b>التعلم بالمهام</b>: كل درس موقف حقيقي من شغلك، ومهمة الموقع بتنقل الكلام للواقع.</p>
      <p>• <b>طلاقة 4/3/2</b>: نفس الكلام في وقت أقل بيدرّب السرعة من غير ضغط أفكار جديدة.</p>
      <p>• <b>عادة ثابتة</b>: نفس الميعاد ونفس المكان كل مرة، وجلسات قصيرة بتطول تدريجيًا من 2 لـ 30 دقيقة.</p>
    </details></div>
  <div class="card"><h2>🎯 أهداف المستوى ${LEVEL_NAMES[S.level]} (Can-do)</h2>${C.CAN_DO[S.level].map(c => `<p>☐ ${esc(c)}</p>`).join('')}</div>
  <div class="card"><h2>الوحدات</h2>${rows.join('')}</div>`);
  setTimeout(() => view.querySelector('.unit.cur')?.scrollIntoView({ block: 'center' }), 50);
}

// ---------- unit check (every 4 lessons) ----------
function unitCheck() {
  setNav('');
  const lv = S.level, u = S.unit.n; const ls = DATA.lessons.filter(l => l.level === lv).slice((u - 1) * 4, u * 4);
  const pool = ls.flatMap(l => l.phrases.map((p, i) => ({ en: p[0], ar: p[1], id: l.id, k: 'p' + i, key: `${l.id}|${i}` })));
  let seed = (lv + 1) * 97 + u * 13 + S.unit.attempts * 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = [...pool].sort(() => rnd() - 0.5).slice(0, 10);
  const R = { recall: 0, pron: 0, flu: null };
  // Part 1: recall
  let i = 0;
  const part1 = () => {
    if (i >= pick.length) return part2();
    const it = pick[i];
    h(`<div class="card"><span class="pill">اختبار الوحدة ${u} · الجزء 1: العبارات من الذاكرة</span><h2 style="margin-top:8px">${i + 1} / ${pick.length}</h2>
      <p style="font-size:20px">${esc(it.ar)}</p><p class="muted">قولها بالإنجليزي.</p>${recBlock()}<div id="res"></div></div>`);
    bindRec(async (x, heard, pw) => {
      const a = align(it.en, heard), ok = a.accuracy >= 100;
      $('#res').innerHTML = lineFeedback(a, heard, pw) + `<p class="center">${ok ? '✅' : '❌ الصح:'} <b class="en">${esc(it.en)}</b></p><button class="btn primary block" id="nx">التالي ←</button>`;
      $('#nx').onclick = () => { if (ok) R.recall++; else C.srsAdd(S, it.key), srsGrade(it.key, false); i++; part1(); };
    }, () => it.en);
  };
  // Part 2: minimal-pair pronunciation (6 words)
  const words = []; for (let k = 0; k < 6; k++) { const s = SOUNDS[Math.floor(rnd() * SOUNDS.length)]; const p = s.pairs[Math.floor(rnd() * s.pairs.length)]; words.push({ w: p[Math.floor(rnd() * 2)], s }); }
  let j = 0;
  const part2 = () => {
    if (j >= words.length) return part3();
    const it = words[j], ref = `I said ${it.w} twice.`;
    h(`<div class="card"><span class="pill">الجزء 2: اختبار النطق</span><h2 style="margin-top:8px">${j + 1} / ${words.length}</h2>
      <p class="en" style="font-size:24px">${esc(ref)}</p><p class="muted">${esc(it.s.name)}: ${esc(it.s.ar)}</p>${recBlock()}<div id="res"></div></div>`);
    bindRec(async (x, heard, pw) => {
      const sc = pw?.find(z => z.word.toLowerCase().replace(/[^a-z]/g, '') === it.w); const s100 = sc ? Math.round(sc.p * 100) : 0; const ok = s100 >= 70;
      $('#res').innerHTML = `<p class="center"><span class="pill ${ok ? 'ok' : 'bad'}">${esc(it.w)}: ${s100}/100</span></p><p class="muted center">اللي اتسمع: <span class="en">${esc(heard)}</span></p><button class="btn primary block" id="nx">التالي ←</button>`;
      $('#nx').onclick = () => { if (ok) R.pron++; else noteWords([{ expected: it.w }]); j++; part2(); };
    }, () => ref);
  };
  // Part 3: 4/3/2 fluency on the unit's last situation
  const part3 = () => fluencyRun(ls[ls.length - 1].tasks[0], '<span class="pill">الجزء 3: الطلاقة 4/3/2</span>', finish, r => { R.flu = r; });
  const finish = () => {
    const rp = Math.round(100 * R.recall / pick.length), pp = Math.round(100 * R.pron / words.length), fo = R.flu?.ok;
    const pass = rp >= 90 && pp >= 80 && fo;
    S.unit.attempts++; S.unit.last = `عبارات ${rp}% · نطق ${pp}% · طلاقة ${fo ? '✅' : '❌'}`;
    if (pass) { S.unit.due = false; award(80); log('unit', { label: `اجتاز الوحدة ${u}`, score: `${rp}/${pp}` }); }
    else log('unit', { label: `الوحدة ${u} لسه ❌`, score: `${rp}/${pp}` });
    save();
    h(`<div class="card center"><div class="big">${pass ? '🏅' : '🔁'}</div><h2>${pass ? `اجتزت الوحدة ${u}` : 'لسه — راجع وأعد'}</h2>
      <p>العبارات من الذاكرة: ${rp}% (المطلوب 90%)</p><p>النطق: ${pp}% (المطلوب 80%)</p><p>الطلاقة 4/3/2: ${fo ? '✅' : '❌ (لازم السرعة تزيد في الجولة الأخيرة وتوصل للهدف)'}</p>
      ${pass ? '<p>🔓 الدرس الجديد اتفتح.</p>' : '<p>العبارات اللي غلطت فيها اتضافت للمراجعة. افتح "🔁 مراجعة اليوم" و"📒 أخطائي" وأعد الاختبار.</p>'}
      <button class="btn primary block" id="b">الرئيسية</button></div>`);
    $('#b').onclick = home;
  };
  part1();
}
function setNav(k) { document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.go === k)); }

// ---------- interactive conversation coach (offline) ----------
// The lesson's character talks with you. Turn-taking is automatic (voice activity detection),
// each answer is scored word by word and the coach reacts like a teacher: praise, recast,
// single-word drill, or a backward build-up of a hard sentence.
const COACH_TEXT = {
  g0: 'Great!', g1: 'Well done.', g2: 'Perfect, that was very clear.', g3: 'Nice, that sounded natural.', g4: 'Excellent.',
  a0: 'Almost. Listen and try again.', a1: "Let's try that once more.",
  w0: "Let's practise this word.", w1: 'Say it after me.',
  m0: 'You mean:', m1: 'A better way to say it is:',
  n0: "Sorry, I didn't catch that.", n1: 'Can you say that again, please?',
  b0: "Let's build it up, piece by piece.", y0: 'Your turn.', q0: 'Now answer my question.',
  e0: 'Great conversation. See you in the next class.', h0: 'Here is a model answer.',
};
const STOP = new Set('a an the to of and or in on at for is are am was were be been i you we he she it they this that these those my your our his her its their me us him them do does did have has had will would can could should shall may might must please just so very ok okay yes no not'.split(' '));
const stem = w => w.replace(/(ing|ed|es|s)$/, '');
function overlap(expected, heard) {
  const E = normWords(expected).filter(w => !STOP.has(w)).map(stem), H = new Set(normWords(heard).map(stem));
  if (!E.length) return normWords(heard).length ? 1 : 0;
  return E.filter(w => H.has(w)).length / E.length;
}
let NOISE = 0.01;
function coachSay(key) { return hasAudio('COACH') && AIDX.COACH.seg[key] ? play('COACH', key) : sayTTS(COACH_TEXT[key], 0.95); }
const pickKey = p => { const ks = Object.keys(COACH_TEXT).filter(k => k[0] === p); return ks[Math.floor(Math.random() * ks.length)]; };

// Record until the speaker stops talking (or max seconds). onLevel gets 0..1 for the meter.
async function listenAuto({ maxSec = 20, silence = 1.3, wait0 = 8, onLevel } = {}) {
  await startRec(); const t0 = Date.now(); let spoke = false, quiet = 0, seen = 0, floor = [];
  return new Promise(res => {
    const iv = setInterval(async () => {
      if (!rec) { clearInterval(iv); return; }
      const ch = rec.chunks; if (ch.length === seen) return; const last = ch[ch.length - 1]; seen = ch.length;
      let e = 0; for (let i = 0; i < last.length; i++) e += last[i] * last[i]; const rms = Math.sqrt(e / last.length);
      const now = Date.now();
      if (now - t0 < 350) { floor.push(rms); return; }
      if (floor.length) { NOISE = Math.max(0.004, floor.reduce((a, b) => a + b, 0) / floor.length); floor = []; }
      const thr = Math.max(0.012, NOISE * 3);
      onLevel && onLevel(Math.min(1, rms / (thr * 4)));
      if (rms > thr) { spoke = true; quiet = 0; } else if (spoke && !quiet) quiet = now;
      const done = (spoke && quiet && now - quiet > silence * 1000) || now - t0 > maxSec * 1000 || (!spoke && now - t0 > wait0 * 1000);
      if (done || listenAuto.force) { listenAuto.force = false; clearInterval(iv); res(await stopRec()); }
    }, 90);
  });
}

function chatUI(title, sub) {
  h(`<div class="card chatcard"><div class="row" style="justify-content:space-between"><b>${esc(title)}</b><span class="muted">${esc(sub || '')}</span></div>
    <div id="chat" class="chat"></div>
    <div class="micbar"><div class="meter"><i id="lvl"></i></div><span id="mst" class="muted">…</span>
      <div class="row" style="justify-content:center"><button class="btn small" id="cStop">■ خلّصت كلامي</button><button class="btn small" id="cHint">💡 تلميح</button><button class="btn small" id="cRep">🔁 كرر</button><button class="btn small" id="cSkip">⏭ تخطّي</button></div></div></div>`);
  $('#cStop').onclick = () => { listenAuto.force = true; };
}
function bubble(who, en, ar, extra = '') {
  const c = $('#chat'); if (!c) return null;
  const d = document.createElement('div'); d.className = `bub ${who}`;
  d.innerHTML = `${en ? `<div class="en">${en}</div>` : ''}${ar ? `<div class="ar">${esc(ar)}</div>` : ''}${extra}`;
  c.appendChild(d); d.scrollIntoView({ block: 'end', behavior: 'smooth' }); return d;
}
const mst = t => { const e = $('#mst'); if (e) e.textContent = t; };
const lvl = v => { const e = $('#lvl'); if (e) e.style.width = `${Math.round(v * 100)}%`; };
function pwHTML(pw, heard) {
  if (!pw || !pw.length) return esc(heard || '…');
  return pw.map(w => { const sc = Math.round(w.p * 100), cls = sc >= GOOD ? 'w-ok' : sc >= 40 ? 'w-mid' : 'w-bad';
    return `<span class="${cls}" ${sc < GOOD ? `data-w="${esc(w.word.replace(/[^A-Za-z']/g, ''))}"` : ''}>${esc(w.word)}<sub>${sc}</sub></span>`; }).join(' ');
}
// one listening turn, returns {x, heard, pw}
async function turn(ref, opts = {}) {
  mst('🎙️ بسمعك… اتكلم'); lvl(0);
  const x = await listenAuto({ ...opts, onLevel: lvl }); lvl(0);
  if (!$('#chat')) return null;
  if (x.length < 16000 * 0.4) return { x, heard: '', pw: [] };
  mst('⏳ بيحلل…');
  if (ref) { const r = await analyzeSpeech(x, ref); return { x, heard: r.text, pw: r.words }; }
  return { x, heard: await transcribe(x), pw: null };
}
let cSkip = false, cRep = null, cHint = null;
function bindChatBtns() {
  $('#cSkip').onclick = () => { cSkip = true; listenAuto.force = true; };
  $('#cRep').onclick = () => cRep && cRep();
  $('#cHint').onclick = () => cHint && cHint();
}

// Drill one word: model it slowly twice, then the learner says it in a short frame.
async function drillWord(word) {
  await coachSay(pickKey('w')); bubble('bot', `<b>${esc(word)}</b>`, C.pronTips(word)[0] || '');
  for (let t = 0; t < 2; t++) {
    await sayTTS(word, 0.55); await wait(200); await sayTTS(word, 0.85);
    const frame = `Say ${word} again.`; bubble('hint', esc(frame), 'قول الجملة دي');
    const r = await turn(frame, { maxSec: 6, wait0: 6 }); if (!r || cSkip) return;
    const sc = r.pw?.find(z => z.word.toLowerCase().replace(/[^a-z']/g, '') === word.toLowerCase()); const s100 = sc ? Math.round(sc.p * 100) : 0;
    bubble('me', pwHTML(r.pw, r.heard));
    if (s100 >= 75) { const m = S.mistakes.words[word.toLowerCase()]; if (m) m.fixed = true; award(5); await coachSay(pickKey('g')); return; }
    await coachSay('a0');
  }
}
// Backward build-up: "...applications" → "payment applications" → … → the whole sentence.
async function buildUp(sentence, id, key) {
  const words = sentence.replace(/[.,!?]/g, '').split(/\s+/); await coachSay('b0');
  for (let n = Math.min(3, words.length); ; n = Math.min(words.length, n + 3)) {
    const part = words.slice(words.length - n).join(' ');
    bubble('bot', esc(part), ''); n === words.length && id ? await play(id, key) : await sayTTS(part, 0.8);
    const r = await turn(part, { maxSec: 12 }); if (!r || cSkip) return false;
    bubble('me', pwHTML(r.pw, r.heard));
    if (n === words.length) return align(part, r.heard).accuracy >= 80;
  }
}

async function convoRun(L, header, next) {
  cSkip = false; currentLessonId = L.id;
  chatUI(`💬 محادثة مع ${L.eng.name}`, 'التطبيق بيسمعك لوحده — اتكلم لما يقولك "دورك"'); bindChatBtns();
  if ($('#chat')) $('#chat').insertAdjacentHTML('beforebegin', header);
  const score = { lines: 0, good: 0, pron: [], fixes: 0 };
  try { await ctx().resume(); } catch {}
  for (let i = 0; i < L.dialogue.length; i++) {
    if (!$('#chat')) return;
    const d = L.dialogue[i];
    if (d[0] !== 'QS') { bubble('bot', esc(d[1]), d[2]); cRep = () => play(L.id, 'd' + i); await play(L.id, 'd' + i); await wait(250); continue; }
    // learner's line: show the Arabic meaning, he says it in English from memory
    cSkip = false; score.lines++;
    const hintB = bubble('hint', '', `دورك: قول بالإنجليزي — ${d[2]}`);
    cHint = () => { hintB.insertAdjacentHTML('afterbegin', `<div class="en">${esc(d[1])}</div>`); cHint = null; };
    cRep = () => play(L.id, 'd' + i);
    await coachSay('y0');
    let done = false;
    for (let att = 0; att < 3 && !done && !cSkip; att++) {
      const r = await turn(d[1]); if (!r) return; if (cSkip) break;
      if (!r.heard) { await coachSay(pickKey('n')); continue; }
      const ov = overlap(d[1], r.heard), pr = pronOf(r.pw) ?? 0, fx = C.recast(r.heard).fixes;
      bubble('me', pwHTML(r.pw, r.heard), '', `<div class="muted" style="font-size:12px">النطق ${pr}/100 · المعنى ${Math.round(ov * 100)}%</div>`);
      notePron(r.pw || []); noteGrammar(fx);
      if (ov >= 0.75 && pr >= GOOD && !fx.length) { score.good++; score.pron.push(pr); award(4); await coachSay(pickKey('g')); done = true; break; }
      if (ov >= 0.5) {
        score.pron.push(pr);
        if (fx.length) { score.fixes++; bubble('fix', fx.map(f => `❌ ${esc(f.wrong)} → ✅ <b>${esc(f.right)}</b>`).join('<br>'), fx[0].ar); }
        if (fx.length || ov < 0.75) { await coachSay(pickKey('m')); bubble('bot', esc(d[1]), d[2]); await play(L.id, 'd' + i); await coachSay('y0'); continue; }
        const worst = (r.pw || []).filter(w => w.p * 100 < GOOD).sort((a, b) => a.p - b.p)[0];
        if (worst) await drillWord(worst.word.replace(/[^A-Za-z']/g, ''));
        done = true; break;
      }
      // not understood
      if (att === 0) { await coachSay('a0'); cHint && cHint(); await play(L.id, 'd' + i); }
      else { done = await buildUp(d[1], L.id, 'd' + i); }
    }
    cHint = null; await wait(200);
  }
  // free questions about the situation
  for (let k = 0; k < L.tasks.length && $('#chat'); k++) {
    cSkip = false; const t = L.tasks[k];
    await coachSay('q0'); bubble('bot', esc(t.q), t.q_ar); cRep = () => sayTTS(t.q, 0.9); await sayTTS(t.q, 0.9);
    cHint = () => { bubble('hint', esc(t.keys.join(' · ')), 'استخدم العبارات دي'); cHint = null; };
    const r = await turn(null, { maxSec: answerSecs(), silence: 2.2, wait0: 10 }); if (!r) return; if (cSkip || !r.heard) continue;
    const f = fluency(r.x, 16000, normWords(r.heard).length), g = gradeTask(t, r.heard, f, answerSecs()), rc = C.recast(r.heard);
    bubble('me', esc(r.heard), '', `<div class="muted" style="font-size:12px">${g.words} كلمة · ${f.wpm} كلمة/دقيقة · عبارات الدرس: ${g.keys.length}</div>`);
    noteGrammar(rc.fixes);
    if (rc.fixes.length) { score.fixes++; bubble('fix', rc.fixes.map(z => `❌ ${esc(z.wrong)} → ✅ <b>${esc(z.right)}</b>`).join('<br>'), rc.fixes[0].ar); await coachSay('m0'); await sayTTS(rc.text, 0.9); }
    else if (g.ok) { await coachSay(pickKey('g')); award(8); }
    if (!g.ok || g.keys.length < 2) { await coachSay('h0'); bubble('bot', esc(t.model), ''); await play(L.id, 'm' + k); }
  }
  if (!$('#chat')) return;
  const avg = score.pron.length ? Math.round(score.pron.reduce((a, b) => a + b, 0) / score.pron.length) : 0;
  await coachSay('e0');
  bubble('sum', `<b>${score.good}/${score.lines}</b> جمل ممتازة من أول مرة · النطق ${avg}/100 · تصحيحات ${score.fixes}`, 'الكلمات الملوّنة اتضافت لدفتر أخطائك.');
  log('convo', { label: 'محادثة تفاعلية', score: `${avg}` });
  mst('✅ خلصت المحادثة'); const b = document.createElement('button'); b.className = 'btn primary block'; b.textContent = 'التالي ←'; b.onclick = next; $('.micbar').appendChild(b);
}

// ---------- free AI conversation (online, optional: uses your own Anthropic API key) ----------
const AI_MODEL = 'claude-haiku-5-5';
async function aiReply(L, history) {
  const sys = `You are ${L.eng.name}, a ${L.eng.role} on a bulk earthworks site in Riyadh (New Murabba-type project). You are talking with Hassan, the site quantity surveyor, who is practising spoken English at CEFR level ${LEVEL_NAMES[S.level]}. Today's situation: ${L.title} — ${L.scene}
Rules: stay in role and keep the conversation going naturally about site work; reply in 1–2 short spoken sentences using vocabulary of level ${LEVEL_NAMES[S.level]}; end with a question most of the time. If Hassan's last message has a grammar or word-choice mistake, give ONE gentle correction. His text comes from speech recognition, so ignore punctuation and small spelling noise.
Return ONLY JSON: {"reply": "...", "reply_ar": "Egyptian Arabic translation of reply", "correction": null or {"wrong": "...", "right": "...", "why_ar": "short Egyptian Arabic explanation"}, "better": null or "a more natural way to say Hassan's whole last sentence"}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': S.aiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 400, system: sys, messages: history }),
  });
  if (!r.ok) throw new Error(`AI ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json(); const txt = j.content?.map(c => c.text || '').join('') || '';
  const m = txt.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { reply: txt, reply_ar: '' };
}
async function aiConvo() {
  setNav(''); const L = lesson() || DATA.lessons[0];
  if (!S.aiKey) { return h(`<div class="card"><h2>🤖 محادثة حرة مع الذكاء الاصطناعي</h2><p>المحادثة الحرة (زي ChatGPT) محتاجة نت ومفتاح API خاص بيك من Anthropic. حطه من ⚙️ الإعدادات ← "الذكاء الاصطناعي".</p><p class="muted">من غير مفتاح، استخدم "💬 محادثة تفاعلية" — شغالة من غير نت.</p><button class="btn primary block" id="b">الإعدادات</button></div>`), $('#b').onclick = settings; }
  if (!navigator.onLine) return toast('المحادثة الحرة محتاجة نت');
  chatUI(`🤖 محادثة حرة مع ${L.eng.name}`, `موقف: ${L.title_ar}`); bindChatBtns(); $('#cHint').hidden = true;
  const hist = []; let stop = false; cSkip = false;
  const endB = document.createElement('button'); endB.className = 'btn block'; endB.textContent = 'إنهاء المحادثة'; endB.onclick = () => { stop = true; listenAuto.force = true; home(); }; $('.micbar').appendChild(endB);
  try {
    hist.push({ role: 'user', content: '(Start the conversation: greet Hassan and open today\'s situation with a question.)' });
    for (let k = 0; k < 30 && !stop && $('#chat'); k++) {
      mst('🤖 بيفكر…');
      const a = await aiReply(L, hist); hist.push({ role: 'assistant', content: JSON.stringify(a) });
      if (k > 0 && a.correction) { bubble('fix', `❌ ${esc(a.correction.wrong)} → ✅ <b>${esc(a.correction.right)}</b>`, a.correction.why_ar || ''); noteGrammar([{ wrong: a.correction.wrong, right: a.correction.right, ar: a.correction.why_ar || '' }]); }
      if (k > 0 && a.better) bubble('hint', `✨ ${esc(a.better)}`, 'طريقة أطبع تقولها بيها');
      bubble('bot', esc(a.reply), a.reply_ar); cRep = () => sayTTS(a.reply, 0.95); await sayTTS(a.reply, 0.95);
      if (stop) break; cSkip = false;
      const r = await turn(null, { maxSec: 40, silence: 1.8, wait0: 12 }); if (!r || stop) break;
      if (!r.heard) { bubble('hint', '', 'ماسمعتش حاجة — اتكلم تاني'); k--; hist.pop(); hist.pop(); hist.push({ role: 'user', content: '(no answer)' }); continue; }
      bubble('me', esc(r.heard)); award(3);
      hist.push({ role: 'user', content: r.heard });
    }
  } catch (e) { bubble('fix', esc(String(e.message || e)), 'اتأكد من النت ومن مفتاح الـ API في الإعدادات'); }
}

// ---------- settings ----------
function settings() {
  stopAudio(); setNav('');
  h(`<div class="card"><h2>الإعدادات</h2>
    <h3>محلل الصوت</h3><select id="model">${Object.entries(MODELS).map(([k, m]) => `<option value="${k}" ${S.model === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
    <p class="muted">لو الموبايل بطيء أو التطبيق بيقفل وقت التحليل، جرّب "خفيف". بعد التغيير اضغط "نزّل كل حاجة" تاني.</p>
    <h3>📶 التنزيل للاستخدام من غير نت</h3>
    <p id="offStat" class="muted">بيحسب…</p><div class="bar"><i id="offBar"></i></div><div style="height:8px"></div>
    <button class="btn block primary" id="dl">⬇️ نزّل كل حاجة (مرة واحدة على الواي فاي)</button>
    <h3>⏰ مواعيد الحصص والتنبيهات</h3>
    <p class="muted">أيام الدرس الجديد (الطريقة 2 بتبقى تاني يوم في نفس المعاد):</p>
    <div class="row">${[6, 0, 1, 2, 3, 4, 5].map(d => `<label class="chip"><input type="checkbox" class="dd" value="${d}" ${S.sched.days.includes(d) ? 'checked' : ''}>${C.DAY_AR[d]}</label>`).join('')}</div>
    <div class="row" style="margin-top:8px"><label>الساعة <input type="time" id="tm" value="${S.sched.time}"></label><button class="btn small" id="svS">حفظ</button></div>
    <div style="height:8px"></div>
    <button class="btn block" id="ics">📅 نزّل جدول الحصص للتقويم (تنبيه قبلها بـ 10 دقايق)</button>
    <div style="height:8px"></div>
    <button class="btn block" id="ntf">🔔 فعّل تنبيهات التطبيق</button>
    <p class="muted">أضمن طريقة للتنبيه: ملف التقويم (افتحه وأضفه لتقويم الموبايل). تنبيهات التطبيق بتظهر لما يكون التطبيق مفتوح أو متفتح من قريب.</p>
    <h3>🤖 الذكاء الاصطناعي (اختياري)</h3>
    <p class="muted">للمحادثة الحرة زي ChatGPT: محتاج نت ومفتاح API خاص بيك من console.anthropic.com (بيتحسب بالاستخدام، تكلفة صغيرة). المفتاح بيتحفظ على الموبايل ده بس.</p>
    <input id="aik" type="password" placeholder="sk-ant-…" value="${esc(S.aiKey || '')}" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);font-family:inherit">
    <div class="row" style="margin-top:8px"><button class="btn small" id="aiS">حفظ</button><button class="btn small" id="aiD">مسح</button></div>
    <h3>نسخة احتياطية من تقدمك</h3>
    <div class="row"><button class="btn" id="exp">⬇ حفظ ملف التقدم</button><label class="btn">⬆ استرجاع<input type="file" id="imp" accept="application/json" hidden></label></div>
    <p class="muted">التقدم محفوظ على الموبايل ده بس. احفظ نسخة كل فترة.</p>
    <h3>عن التطبيق</h3><p class="muted">كل الحوارات والأصوات وتحليل النطق شغالين على الموبايل نفسه من غير نت، بعد التنزيل.</p></div>`);
  $('#svS').onclick = () => { const d = [...view.querySelectorAll('.dd:checked')].map(x => +x.value); if (!d.length) return toast('اختار يوم واحد على الأقل'); S.sched.days = d; S.sched.time = $('#tm').value || '21:00'; save(); toast('اتحفظ ✅ نزّل ملف التقويم تاني'); };
  $('#ics').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([C.icsFile(S.sched, S.courseStart)], { type: 'text/calendar' })); a.download = 'site-talk-classes.ics'; a.click(); };
  $('#ntf').onclick = async () => { if (!('Notification' in window)) return toast('المتصفح ده مايدعمش التنبيهات'); const p = await Notification.requestPermission(); toast(p === 'granted' ? 'التنبيهات اتفعلت ✅' : 'التنبيهات مش مفعلة'); if (p === 'granted') remind(true); };
  $('#dl').onclick = () => downloadAll(); refreshOfflineStatus();
  $('#aiS').onclick = () => { S.aiKey = $('#aik').value.trim(); save(); toast(S.aiKey ? 'اتحفظ ✅' : 'اتمسح'); };
  $('#aiD').onclick = () => { S.aiKey = ''; $('#aik').value = ''; save(); toast('اتمسح'); };
  $('#model').onchange = e => { S.model = e.target.value; asr = null; asrLoading = null; save(); toast('اتغير. نزّل الملفات تاني من الرئيسية.'); };
  $('#exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...S, aiKey: undefined })], { type: 'application/json' })); a.download = `sitetalk-progress-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
  $('#imp').onchange = async e => { try { const o = JSON.parse(await e.target.files[0].text()); if (typeof o.level !== 'number') throw 0; S = Object.assign(structuredClone(DEFAULT), o); save(); toast('اتسترجع التقدم ✅'); home(); } catch { toast('الملف مش صالح'); } };
}

// ---------- boot ----------
$('#btnHome').onclick = () => home();
$('#btnSettings').onclick = () => settings();
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => ({ home, plan: planView, book: phrasebook, mis: mistakesView })[b.dataset.go]());
view.addEventListener('click', e => { const w = e.target.closest('[data-w]'); if (w) wordDrill(w.dataset.w); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
loadData().then(() => { home(); remind(); setInterval(remind, 60e3); }).catch(e => h(`<div class="card"><h2>تعذر تحميل البيانات</h2><p class="muted">${esc(e.message)}</p><p>لو أول مرة تفتح التطبيق، افتحه وإنت متصل بالنت.</p></div>`));
window.__st = { get S() { return S; }, set S(v) { S = v; save(); }, align, transcribe, getASR };
