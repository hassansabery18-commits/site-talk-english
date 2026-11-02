// Site Talk English — offline speaking & pronunciation trainer.
import { align, normWords, fluency, gradeTask, mastery, lessonPassed, WPM_TARGET, setNames } from './scoring.js';

const LEVEL_NAMES = ['B1', 'B1+', 'B2', 'B2+'];
const MINUTE_STEPS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 30];
const UP_AFTER = 3;          // consecutive lessons mastered with >= 90% (1st or 2nd attempt) before the session gets longer
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
};
let S = load();
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
function speakerName(L, who) { return who === 'QS' ? 'Hassan (QS)' : `${L.eng.name} (${L.eng.role})`; }
function answerSecs() { return Math.min(90, Math.max(20, minutes() * 8)); }
function readCount() { const m = minutes(); return m < 5 ? 3 : m < 10 ? 4 : 5; }
function soundOf(L) { return (parseInt(L.id.split('-').pop(), 10) - 1) % SOUNDS.length; }

// ---------- home ----------
async function home() {
  stopAudio();
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
  } else {
    const st = { new: '', failed: '<span class="pill bad">لسه ما أتقنتهوش</span>', pending: '<span class="pill acc">مستني الاختبار</span>' }[S.status] || '';
    main = `<div class="card">
      <div class="row" style="justify-content:space-between"><span class="pill">الدرس ${S.lessonNum} من ${LESSONS_PER_LEVEL}</span>${st}</div>
      <h1 class="en" style="margin-top:8px">${esc(L.title)}</h1>
      <p>${esc(L.title_ar)}</p>
      <p class="muted">${esc(L.scene)}</p>
      <button class="btn primary block" id="goSession">${S.sessionDone ? 'جلسة مراجعة تانية' : 'ابدأ جلسة الدرس'} (${minutes()} دقايق)</button>
      <div style="height:10px"></div>
      <button class="btn dark block" id="goTest" ${S.sessionDone ? '' : 'disabled'}>🎙️ اختبار الدرس${S.attempts ? ` (المحاولة ${S.attempts + 1})` : ''}</button>
      ${S.sessionDone ? '' : '<p class="muted center">الاختبار بيتفتح بعد ما تخلّص جلسة الدرس.</p>'}
      ${S.failed.length ? `<p class="lock">ركّز على: ${esc(S.failed.join('، '))}</p>` : ''}
      <p class="muted center">🔒 الدرس اللي بعده مقفول لحد ما تتقن الدرس ده تحدثًا.</p>
    </div>`;
  }
  h(`${main}
  <div class="card"><h2>تقدمك</h2>
    <div class="grid2">
      <div class="stat"><b>${LEVEL_NAMES[S.level]}</b><span>المستوى</span></div>
      <div class="stat"><b>${S.passedInLevel}/${LESSONS_PER_LEVEL}</b><span>دروس أتقنتها في المستوى</span></div>
      <div class="stat"><b>${minutes()} د</b><span>مدة الجلسة الحالية</span></div>
      <div class="stat"><b>${S.streak}/${UP_AFTER}</b><span>إتقان متتالي ≥ 90% للزيادة</span></div>
    </div>
    <div style="margin-top:12px" class="bar"><i style="width:${pct}%"></i></div>
    <p class="muted">المدة بتبدأ دقيقتين وبتزيد لحد 30 دقيقة، بعد ${UP_AFTER} دروس ورا بعض تتقنهم بـ 90% أو أكتر من أول أو تاني محاولة. سرعة الكلام بتزيد تدريجيًا مع الدروس والمستويات.</p>
  </div>
  ${offlineCard()}
  ${historyCard()}`);
  $('#goSession')?.addEventListener('click', () => session());
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
  const shell = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/scoring.js', 'js/whisper.js', 'js/melfb.json', 'manifest.json',
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
  }[step];
}
function planSession(L) {
  const target = minutes() * 60;
  const first = ['listen', 'phrases', 'shadow', 'sound', 'listen2', 'roleQS', 'hard', 'tasks', 'roleENG'];
  const cycle = ['shadowCheck', 'roleQS', 'listen2', 'roleENG', 'tasks'];
  const plan = []; let t = 0;
  for (const s of first) {
    const e = estimate(s, L);
    if (plan.length && t >= target * 0.9) break;
    if (plan.length && t + e > target * 1.15) continue;
    plan.push(s); t += e;
  }
  let k = 0;
  while (t < target * 0.9 && k < 60) { const s = cycle[k % cycle.length]; plan.push(s); t += estimate(s, L); k++; }
  return { plan, est: Math.round(t / 60 * 10) / 10 };
}
const STEP_AR = { listen: 'اسمع الحوار بالنص والترجمة', listen2: 'اسمع من غير ما تبص على النص', phrases: 'العبارات المهمة', shadow: 'كرر ورا كل جملة (shadowing)', sound: 'صوت الدرس', hard: 'كلمات صعبة النطق', roleQS: 'لعب أدوار: إنت حسن', roleENG: 'لعب أدوار: إنت الطرف التاني', shadowCheck: 'كرر وسجّل كل جملة', tasks: 'تدريب الموقفين' };

// ---------- session ----------
let sessionAbort = false;
async function session() {
  const L = lesson(); const { plan, est } = planSession(L); sessionAbort = false;
  let idx = 0;
  const next = async () => {
    stopAudio();
    if (idx >= plan.length) return sessionEnd(L);
    const step = plan[idx];
    const header = `<div class="row" style="justify-content:space-between"><span class="pill">${idx + 1} / ${plan.length}</span><span class="muted">حوالي ${est} دقيقة</span></div>
      <div class="steps">${plan.map((_, i) => `<i class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"></i>`).join('')}</div>
      <h2>${STEP_AR[step]}</h2>`;
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
      <button class="btn dark block" id="pl">▶ شغّل الحوار</button><div style="height:10px"></div>${linesHTML(L)}${nextBtn()}</div>`);
    bindAr(); $('#next').onclick = next;
    $('#pl').onclick = async () => { for (let i = 0; i < L.dialogue.length; i++) { if (!$('#lines')) return; mark(i); await play(L.id, 'd' + i); await wait(350); } mark(-1); };
  },
  async listen2(L, header, next) {
    currentLessonId = L.id;
    h(`<div class="card">${header}<p class="muted">اسمع وحاول تفهم من غير ما تقرا. لو احتجت، اضغط "إظهار النص".</p>
      <button class="btn dark block" id="pl">▶ شغّل الحوار</button>
      <div class="toggle"><button class="btn" id="show">إظهار النص</button></div>
      <div class="hide-en hide-ar" id="wrap">${linesHTML(L).replace('class="toggle"', 'class="toggle" hidden')}</div>${nextBtn()}</div>`);
    bindAr(); $('#next').onclick = next;
    $('#show').onclick = () => { $('#wrap').className = ''; $('#lines').classList.toggle('hide-ar', !S.showAr); };
    $('#pl').onclick = async () => { for (let i = 0; i < L.dialogue.length; i++) { if (!$('#lines')) return; mark(i); await play(L.id, 'd' + i); await wait(350); } mark(-1); };
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
        $('#res').innerHTML = taskFeedback(g, heard, f);
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
    $('#panel').innerHTML = `<p class="center">🎙️ دورك: قول الجملة</p><p class="en center">${esc(d[1])}</p>${recBlock(true)}<div id="res"></div>
      <div class="row" style="justify-content:center"><button class="btn small" id="hear">▶ اسمعها</button><button class="btn small" id="skip">تخطّي ←</button></div>`;
    $('#hear').onclick = () => play(L.id, 'd' + i);
    $('#skip').onclick = () => { i++; step(); };
    bindRec(async (x, heard) => {
      const a = align(d[1], heard);
      $('#res').innerHTML = lineFeedback(a, heard) + `<div class="row" style="justify-content:center"><button class="btn small primary" id="cont">كمّل ←</button></div>`;
      $('#cont').onclick = () => { i++; step(); };
    });
  };
  step();
}

function recBlock(compact) {
  return `<div class="center" style="margin:${compact ? 6 : 14}px 0">
    <button class="rec" id="rec">🎙️</button><p class="muted" id="recSt">اضغط وسجّل، واضغط تاني لما تخلّص</p>
    ${TEST_MODE ? '<input type="file" id="recFile" accept="audio/*">' : ''}</div>`;
}
function bindRec(onDone) {
  const b = $('#rec'), st = $('#recSt'); let on = false, timer;
  const finish = async (x) => {
    try {
      const heard = await transcribe(x, m => st.textContent = m);
      st.textContent = 'اضغط عشان تسجّل تاني';
      await onDone(x, heard);
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
function lineFeedback(a, heard) {
  const words = []; for (const o of a.ops) { if (o.t === 'ok') words.push(`<span class="w-ok">${esc(pretty(o.r))}</span>`); else if (o.t === 'miss') words.push(`<span class="w-bad">${esc(pretty(o.r))}</span>`); }
  return `<p class="en center">${words.join(' ')}</p><p class="center"><span class="pill ${a.accuracy === 100 ? 'ok' : 'bad'}">${a.matched}/${a.target} كلمة اتفهمت صح</span></p>
    <p class="muted center">اللي اتسمع: <span class="en">${esc(heard || '—')}</span></p>`;
}
function taskFeedback(g, heard, f) {
  return `<p class="muted">اللي اتسمع: <span class="en">${esc(heard || '—')}</span></p>
    <p>${g.onTopic ? '✅' : '❌'} عبارات الدرس: ${g.keys.length ? `<span class="en">${esc(g.keys.join(', '))}</span>` : 'ولا واحدة'}</p>
    <p>${g.longEnough ? '✅' : '❌'} الطول: ${g.words} كلمة (المطلوب ${g.minWords} على الأقل)</p>
    <p>⏱️ السرعة: ${f.wpm} كلمة/دقيقة · وقفات طويلة: ${f.longPauses}</p>`;
}

function sessionEnd(L) {
  S.sessionDone = true; if (S.status === 'new') S.status = 'pending'; save(); log('session', { label: `جلسة ${minutes()} د` });
  h(`<div class="card center"><div class="big">👏</div><h2>خلّصت جلسة الدرس</h2>
    <p>دلوقتي اختبار الدرس: ${readCount()} جمل تقراها + موقفين تتكلم فيهم. محتاج <b>100%</b> في الجمل و<b>80%</b> إتقان على الأقل عشان الدرس اللي بعده يتفتح.</p>
    <button class="btn primary block" id="t">🎙️ ابدأ اختبار الدرس</button><div style="height:10px"></div>
    <button class="btn block" id="later">بعدين</button></div>`);
  $('#t').onclick = lessonTest; $('#later').onclick = home;
}

// ---------- lesson test ----------
async function lessonTest() {
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
      <p class="en" style="font-size:20px;line-height:1.6">${esc(L.read[ri])}</p>
      <div class="row"><button class="btn small" id="h1">▶ اسمعها</button><button class="btn small" id="h2">▶ ببطء</button></div>
      ${recBlock()}<div id="res"></div></div>`);
    $('#h1').onclick = () => play(L.id, 'r' + ri); $('#h2').onclick = () => play(L.id, 'rs' + ri);
    bindRec(async (x, heard) => {
      const a = align(L.read[ri], heard);
      $('#res').innerHTML = lineFeedback(a, heard) + `<div class="row" style="justify-content:center"><button class="btn primary" id="ok">التالي ←</button></div><p class="muted center">لو حاسس إن التسجيل مش واضح (دوشة)، سجّل تاني قبل ما تكمّل.</p>`;
      $('#ok').onclick = () => { R.reads[k] = { ri, a, heard }; R.pcm.push({ x, heard }); k++; readStep(); };
    });
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
    const pass = lessonPassed(acc, R.tasks, m);
    S.attempts++;
    const problems = R.reads.flatMap(r => r.a.problems.map(p => ({ ...p, s: L.read[r.ri] })));
    if (pass) {
      const good = m.total >= 90 && S.attempts <= 2;
      S.streak = good ? S.streak + 1 : 0;
      let up = false;
      if (S.streak >= UP_AFTER && S.minutesIdx < MINUTE_STEPS.length - 1) { S.minutesIdx++; S.streak = 0; up = true; }
      log('lesson-test', { label: 'نجح ✅', score: `${m.total}%` });
      S.passedInLevel++; S.status = 'new'; S.attempts = 0; S.failed = []; S.sessionDone = false;
      S.lessonNum++;
      save();
      resultScreen(L, { acc, m, flu, pass, problems, tasks: R.tasks, up });
    } else {
      S.streak = 0; S.status = 'failed';
      S.failed = [...new Set(problems.map(p => p.expected).filter(Boolean).map(pretty))].slice(0, 8);
      if (!R.tasks.every(t => t.onTopic)) S.failed.push('استخدام عبارات الدرس');
      if (flu.wpm < WPM_TARGET[S.level]) S.failed.push('السرعة');
      log('lesson-test', { label: 'لسه ❌', score: `${m.total}%` });
      save();
      resultScreen(L, { acc, m, flu, pass, problems, tasks: R.tasks });
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
    <h3>🗣️ الموقفين</h3>${r.tasks.map((g, i) => `<p>${g.ok ? '✅' : '❌'} الموقف ${i + 1}: ${g.words} كلمة، عبارات الدرس: ${g.keys.length}</p>`).join('')}
    <h3>⏱️ الطلاقة</h3><p>${r.flu.wpm} كلمة/دقيقة (الهدف ${t}) · وقفات طويلة: ${r.flu.longPauses}</p>
    <p class="muted">التحليل آلي: بيتأكد إن كل كلمة مفهومة وبيقيس السرعة والوقفات، ومش بيحكم على اللكنة زي مدرس.</p>
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
    });
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

// ---------- settings ----------
function settings() {
  stopAudio();
  h(`<div class="card"><h2>الإعدادات</h2>
    <h3>محلل الصوت</h3><select id="model">${Object.entries(MODELS).map(([k, m]) => `<option value="${k}" ${S.model === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
    <p class="muted">لو الموبايل بطيء أو التطبيق بيقفل وقت التحليل، جرّب "خفيف". بعد التغيير اضغط "نزّل كل حاجة" تاني.</p>
    <h3>نسخة احتياطية من تقدمك</h3>
    <div class="row"><button class="btn" id="exp">⬇ حفظ ملف التقدم</button><label class="btn">⬆ استرجاع<input type="file" id="imp" accept="application/json" hidden></label></div>
    <p class="muted">التقدم محفوظ على الموبايل ده بس. احفظ نسخة كل فترة.</p>
    <h3>عن التطبيق</h3><p class="muted">كل الحوارات والأصوات وتحليل النطق شغالين على الموبايل نفسه من غير نت، بعد التنزيل.</p></div>`);
  $('#model').onchange = e => { S.model = e.target.value; asr = null; asrLoading = null; save(); toast('اتغير. نزّل الملفات تاني من الرئيسية.'); };
  $('#exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(S)], { type: 'application/json' })); a.download = `sitetalk-progress-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
  $('#imp').onchange = async e => { try { const o = JSON.parse(await e.target.files[0].text()); if (typeof o.level !== 'number') throw 0; S = Object.assign(structuredClone(DEFAULT), o); save(); toast('اتسترجع التقدم ✅'); home(); } catch { toast('الملف مش صالح'); } };
}

// ---------- boot ----------
$('#btnHome').onclick = () => home();
$('#btnSettings').onclick = () => settings();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
loadData().then(home).catch(e => h(`<div class="card"><h2>تعذر تحميل البيانات</h2><p class="muted">${esc(e.message)}</p><p>لو أول مرة تفتح التطبيق، افتحه وإنت متصل بالنت.</p></div>`));
window.__st = { get S() { return S; }, set S(v) { S = v; save(); }, align, transcribe, getASR };
