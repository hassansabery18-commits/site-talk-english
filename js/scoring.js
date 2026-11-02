// Scoring: word accuracy (read-aloud), speaking-task checks, fluency, mastery.

const NUM = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', hundred: '100',
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th',
};
const CONTR = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are', "it's": 'it is', "that's": 'that is',
  "what's": 'what is', "there's": 'there is', "here's": 'here is', "let's": 'let us', "he's": 'he is', "she's": 'she is',
  "i'll": 'i will', "we'll": 'we will', "you'll": 'you will', "they'll": 'they will', "it'll": 'it will', "he'll": 'he will', "she'll": 'she will',
  "i'd": 'i would', "we'd": 'we would', "you'd": 'you would', "they'd": 'they would',
  "i've": 'i have', "we've": 'we have', "you've": 'you have', "they've": 'they have',
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not', "can't": 'can not', "cannot": 'can not', "won't": 'will not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not', "haven't": 'have not', "hasn't": 'has not',
  "shouldn't": 'should not', "couldn't": 'could not', "wouldn't": 'would not', "mustn't": 'must not',
};
// Single letters (zone names etc.) and spelling variants the recognizer may write differently.
const ALIAS = {
  bee: 'b', be: 'b', see: 'c', sea: 'c', dee: 'd', ee: 'e', eff: 'f', gee: 'g', jay: 'j', kay: 'k', el: 'l', em: 'm',
  en: 'n', oh: 'o', pea: 'p', pee: 'p', queue: 'q', are: 'are', ar: 'r', tee: 't', tea: 't', you: 'you', vee: 'v', ex: 'x', why: 'why', zed: 'z', zee: 'z',
  ok: 'okay', 'o.k.': 'okay', centimeters: 'centimetres', meters: 'metres', metre: 'metres', meter: 'metres',
  summarise: 'summarize', organise: 'organize', colour: 'color', programme: 'program', analyse: 'analyze', tonne: 'ton', tonnes: 'tons',
  'p.p.e.': 'ppe', 'p.p.e': 'ppe', percent: '%', robbie: 'ravi', rabbi: 'ravi', ravie: 'ravi', khalid: 'khaled', yousef: 'yusuf', yusef: 'yusuf', ahmad: 'ahmed', sara: 'sarah', hameed: 'hamid',
};

export function normWords(s) {
  let t = (' ' + s.toLowerCase() + ' ')
    .replace(/[’`]/g, "'")
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/(\d)\s*%/g, '$1 %')
    .replace(/\bp\.\s?p\.\s?e\.?/g, 'ppe')
    .replace(/o'clock/g, 'oclock');
  const words = [];
  for (let w of t.split(/[\s\-–—/]+/)) {
    w = w.replace(/^[^a-z0-9%']+|[^a-z0-9%']+$/g, '');
    if (!w) continue;
    if (CONTR[w]) { words.push(...CONTR[w].split(' ')); continue; }
    w = w.replace(/'s$/, '');
    w = w.replace(/'/g, '');
    if (NUM[w]) w = NUM[w];
    if (/^\d+(st|nd|rd|th)$/.test(w)) w = w.replace(/(\d+)(st|nd|rd|th)/, '$1') + 'th';
    if (NUM[w] === undefined && /^\d+th$/.test(w)) { /* keep */ }
    if (ALIAS[w]) w = ALIAS[w];
    words.push(w);
  }
  // ordinal tokens made comparable: "3rd" and "third" -> "3th"
  return words.map(w => w.replace(/^(\d+)(st|nd|rd)$/, '$1th'));
}

// Proper names (people, places) are spelled many ways by the recognizer: accept close spellings.
let NAMES = new Set(['hassan', 'riyadh']);
export function setNames(list) { for (const n of list) for (const w of normWords(n)) if (w.length >= 3) NAMES.add(w); }
function edit(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function fixNames(H, R) {
  const names = [...NAMES].filter(n => R.includes(n));
  return H.map(w => {
    if (w.length < 3 || NAMES.has(w)) return w;
    for (const n of names) if (w[0] === n[0] && Math.abs(w.length - n.length) <= 2 && edit(w, n) <= 2) return n;
    return w;
  });
}

// Longest-common-subsequence alignment of reference vs heard words.
export function align(refText, hypText) {
  const R = normWords(refText), H = fixNames(normWords(hypText), R);
  const n = R.length, m = H.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = R[i] === H[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && R[i] === H[j]) { ops.push({ t: 'ok', r: R[i], h: H[j] }); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push({ t: 'ins', h: H[j] }); j++; }
    else { ops.push({ t: 'miss', r: R[i] }); i++; }
  }
  // merge adjacent miss+ins into substitutions for display
  const problems = []; let k = 0;
  while (k < ops.length) {
    if (ops[k].t === 'ok') { k++; continue; }
    const miss = [], ins = [];
    while (k < ops.length && ops[k].t !== 'ok') { if (ops[k].t === 'miss') miss.push(ops[k].r); else ins.push(ops[k].h); k++; }
    if (miss.length) problems.push({ expected: miss.join(' '), heard: ins.join(' ') });
  }
  const matched = dp[0][0];
  return { target: n, matched, accuracy: n ? Math.round(1000 * matched / n) / 10 : 0, problems, ops, refWords: R };
}

// Fluency from raw 16 kHz audio: speaking time (first to last voiced frame), long pauses.
export function fluency(x, sr, wordsHeard) {
  const f = Math.round(0.02 * sr), n = Math.floor(x.length / f);
  if (n < 2) return { speech: 0, wpm: 0, longPauses: 0, longest: 0 };
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let e = 0; for (let j = i * f; j < (i + 1) * f; j++) e += x[j] * x[j]; rms[i] = Math.sqrt(e / f); }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const thr = 0.12 * sorted[Math.floor(0.95 * (n - 1))];
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) if (rms[i] > thr) { if (first < 0) first = i; last = i; }
  if (first < 0) return { speech: 0, wpm: 0, longPauses: 0, longest: 0 };
  const speech = (last - first + 1) * 0.02;
  let run = 0, pauses = [];
  for (let i = first; i <= last; i++) {
    if (rms[i] <= thr) run++;
    else { if (run * 0.02 >= 0.6) pauses.push(+(run * 0.02).toFixed(2)); run = 0; }
  }
  return { speech: +speech.toFixed(1), wpm: Math.round(wordsHeard / speech * 60), longPauses: pauses.length, longest: pauses.length ? Math.max(...pauses) : 0 };
}

// Does the heard text contain this key phrase? (all its words, in order, gaps allowed)
export function hasKey(heardWords, key) {
  const k = normWords(key); let p = 0;
  for (const w of heardWords) { if (w === k[p]) p++; if (p === k.length) return true; }
  return false;
}

export const WPM_TARGET = [90, 110, 120, 130];

// Speaking task check. answerSecs = required length.
export function gradeTask(task, heard, flu, answerSecs) {
  const words = normWords(heard);
  const keys = task.keys.filter(k => hasKey(words, k));
  const minWords = Math.round(answerSecs * 0.9); // ~55 wpm minimum content
  const longEnough = words.length >= minWords;
  const onTopic = keys.length >= 1;
  const understandable = words.length >= 5;
  const pts = (onTopic ? 4.5 : 0) + (longEnough ? 4 : Math.min(4, 4 * words.length / Math.max(1, minWords))) + (understandable ? 4 : 0);
  return { words: words.length, minWords, keys, onTopic, longEnough, understandable, ok: onTopic && longEnough && understandable, pts: Math.round(pts * 10) / 10 };
}

// Mastery: accuracy*0.60 + tasks (2 x 12.5) + fluency 15.
export function mastery(acc, taskResults, flu, level) {
  const target = WPM_TARGET[level];
  let f = Math.min(1, flu.wpm / target) * 15 - 2 * Math.max(0, flu.longPauses - 3);
  f = Math.max(0, f);
  const t = taskResults.reduce((s, r) => s + r.pts, 0);
  const total = acc * 0.6 + t + f;
  return { total: Math.round(total * 10) / 10, parts: { accuracy: +(acc * 0.6).toFixed(1), tasks: +t.toFixed(1), fluency: +f.toFixed(1) }, target };
}

export function lessonPassed(acc, taskResults, m) {
  const keys = taskResults.reduce((s, r) => s + r.keys.length, 0);
  return acc === 100 && taskResults.every(r => r.ok) && keys >= 2 && m.total >= 80;
}
