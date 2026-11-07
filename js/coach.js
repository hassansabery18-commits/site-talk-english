// Coach: grammar correction, pronunciation tips, spaced repetition, course calendar.
// Rule-based and fully offline. Rules target the errors Arabic speakers make most often.

// ---------- grammar / usage correction ----------
const V3 = 'go|have|do|need|want|work|say|come|make|take|give|know|think|check|send|start|finish|use|look|seem|mean|agree|cost|stop|wait|ask|show|bring|run';
const RULES = [
  { re: /\b(he|she|it) (don't|do not)\b/g, fix: (m, s, n) => `${s} ${n === 'do not' ? 'does not' : "doesn't"}`, ar: `مع he / she / it في النفي نقول doesn't.` },
  { re: /\bi am agree\b/g, fix: () => 'I agree', ar: `agree فعل، مش صفة: نقول I agree من غير am.` },
  { re: /\b(he|she|it|the (?:foreman|engineer|consultant|surveyor|driver|truck|excavator|contractor|subcontractor|client|test|road|layer|machine)) (go|have|do|need|want|work|say|come|make|take|give|know|think|check|send|start|finish|use|look|seem|mean|agree|cost|stop|wait|ask|show|bring|run|depend)\b/g,
    fix: (m, s, v) => `${s} ${v === 'have' ? 'has' : v === 'do' ? 'does' : v === 'go' ? 'goes' : /(sh|ch|s|x)$/.test(v) ? v + 'es' : v + 's'}`,
    ar: `مع he / she / it (المفرد الغايب) في المضارع البسيط بنزوّد s للفعل: he needs, it costs, he has.` },
  { re: /\b(didn't|did not|does not|doesn't|do not|don't) (went|came|saw|took|gave|made|sent|did|had|said|got|brought|found|(?:\w+)ed)\b/g,
    fix: (m, a, v) => `${a} ${BASE[v] || v.replace(/ied$/, 'y').replace(/([^aeiou])\1ed$/, '$1').replace(/ed$/, '')}`,
    ar: `بعد did / didn't / does الفعل بيرجع لأصله: didn't go مش didn't went.` },
  { re: /\b(can|should|must|will|could|would|might) to (\w+)/g, fix: (m, a, v) => `${a} ${v}`, ar: `بعد can / should / must / will مفيش to: we must finish.` },
  { re: /\bmore (better|worse|bigger|faster|cheaper|easier|harder|higher|lower|longer|safer)\b/g, fix: (m, a) => a, ar: `better لوحدها معناها "أحسن" — مانقولش more better.` },
  { re: /\bdiscuss about\b/g, fix: () => 'discuss', ar: `discuss من غير about: let's discuss the variation.` },
  { re: /\bexplain me\b/g, fix: () => 'explain to me', ar: `نقول explain to me أو explain it to me.` },
  { re: /\bsay me\b/g, fix: () => 'tell me', ar: `مع الشخص بنستخدم tell: tell me, tell him.` },
  { re: /\b(we|they|you) was\b/g, fix: (m, a) => `${a} were`, ar: `we / they / you بييجي معاهم were مش was.` },
  { re: /\b(he|she|it) were\b/g, fix: (m, a) => `${a} was`, ar: `he / she / it بييجي معاهم was في الماضي.` },
  { re: /\b(i|we|they|you) is\b/g, fix: (m, a) => `${a} ${a === 'i' ? 'am' : 'are'}`, ar: `I am, we/they/you are.` },
  { re: /\bthere is (many|some|two|three|four|five|several|a lot of|lots of) (\w+s)\b/g, fix: (m, a, b) => `there are ${a} ${b}`, ar: `مع الجمع نقول there are.` },
  { re: /\bsince (\d+|a|one|two|three|four|five|six|several|few) (minutes?|hours?|days?|weeks?|months?|years?)\b/g, fix: (m, a, b) => `for ${a} ${b}`, ar: `مع المدة نستخدم for (for two days)، وsince مع نقطة بداية (since Sunday).` },
  { re: /\bhow much (trucks|loads|trips|workers|days|hours|tests|layers|samples|drawings|machines|people)\b/g, fix: (m, a) => `how many ${a}`, ar: `مع حاجة بتتعد (جمع) نقول how many.` },
  { re: /\bmany (equipment|material|soil|water|time|money|information|work|sand|fuel)\b/g, fix: (m, a) => `much ${a}`, ar: `الحاجات اللي ماتتعدش نستخدم معاها much أو a lot of.` },
  { re: /\b(equipments|informations|advices|feedbacks|furnitures|peoples|staffs|works done)\b/g, fix: (m, a) => ({ equipments: 'equipment', informations: 'information', advices: 'advice', feedbacks: 'feedback', furnitures: 'furniture', peoples: 'people', staffs: 'staff', 'works done': 'work done' }[a]), ar: `الكلمة دي مالهاش جمع بـ s في الإنجليزي.` },
  { re: /\bdo (a |the )?mistakes?\b/g, fix: m => m.replace(/^do/, 'make'), ar: `نقول make a mistake.` },
  { re: /\b(open|close) the (light|lights|ac|air conditioner|generator|pump)\b/g, fix: (m, a, b) => `turn ${a === 'open' ? 'on' : 'off'} the ${b}`, ar: `للأجهزة نقول turn on / turn off.` },
  { re: /\bdepend(s)? of\b/g, fix: (m, s) => `depend${s || ''} on`, ar: `depend on.` },
  { re: /\barrive(d)? to\b/g, fix: (m, d) => `arrive${d || ''} at`, ar: `arrive at (مكان محدد) أو arrive in (مدينة) — مش arrive to.` },
  { re: /\bi am (work|go|come|check|prepare|measure|send|wait|call)\b/g, fix: (m, v) => `I'm ${ING[v]}`, ar: `إما I work (عادة) أو I'm working (دلوقتي) — مانجمعش am مع الفعل الأصلي.` },
  { re: /\bwhy you (didn't|don't|did not|do not|are|were|can't)\b/g, fix: (m, a) => `why ${a.replace(' not', 'n\'t')} you`, ar: `في السؤال الفعل المساعد بييجي قبل الفاعل: why didn't you…?` },
  { re: /\bwhere you (are|were|go|put)\b/g, fix: (m, a) => (a === 'are' || a === 'were') ? `where ${a} you` : `where did you ${a}`, ar: `في السؤال: where are you? / where did you put…?` },
  { re: /\b(a) (excavator|engineer|inspection|area|order|hour|update|issue|estimate|approval|email|invoice|item|extra|answer|error|office)\b/g, fix: (m, a, w) => `an ${w}`, ar: `قبل الكلمة اللي بتبدأ بصوت حرف متحرك نقول an: an excavator, an hour.` },
  { re: /\bthe (most|more) (good)\b/g, fix: (m, a) => (a === 'most' ? 'the best' : 'better'), ar: `good → better → the best.` },
  { re: /\bmarried with\b/g, fix: () => 'married to', ar: `married to.` },
  { re: /\bin (the )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, fix: (m, t, d) => `on ${d}`, ar: `مع الأيام نستخدم on: on Sunday.` },
  { re: /\bi have (\d+|two|three|four|five|ten|twelve) years? (here|in this company|on site)\b/g, fix: (m, n, p) => `I have been ${p} for ${n} years`, ar: `للمدة لحد دلوقتي: I have been here for 12 years.` },
];
const BASE = { went: 'go', came: 'come', saw: 'see', took: 'take', gave: 'give', made: 'make', sent: 'send', did: 'do', had: 'have', said: 'say', got: 'get', brought: 'bring', found: 'find' };
const ING = { work: 'working', go: 'going', come: 'coming', check: 'checking', prepare: 'preparing', measure: 'measuring', send: 'sending', wait: 'waiting', call: 'calling' };

export function checkGrammar(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[’`]/g, "'").replace(/[.,!?;:"]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const out = [], seen = new Set();
  for (const r of RULES) {
    r.re.lastIndex = 0; let m;
    while ((m = r.re.exec(t))) {
      const wrong = m[0].trim(), right = r.fix(...m);
      if (right.toLowerCase() === wrong || seen.has(wrong)) continue;
      seen.add(wrong); out.push({ wrong, right, ar: r.ar });
    }
  }
  return out;
}
// Corrected version of the whole answer (the "recast" a teacher would give).
// Fixes can overlap ("he don't went"), so correct, re-check and repeat.
export function recast(text) {
  let s = String(text || '').trim(); const all = [];
  for (let k = 0; k < 4; k++) {
    const fixes = checkGrammar(s); if (!fixes.length) break;
    let low = ' ' + s + ' ', changed = false;
    for (const f of fixes) {
      const re = new RegExp(`(^|[^a-z'])${f.wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s,]+')}(?=[^a-z']|$)`, 'i');
      const n = low.replace(re, (m, pre) => pre + f.right);
      if (n !== low) { low = n; changed = true; all.push(f); }
    }
    s = low.trim(); if (!changed) break;
  }
  return { text: s.charAt(0).toUpperCase() + s.slice(1), fixes: all };
}

// ---------- pronunciation tips for Arabic speakers ----------
export function pronTips(word) {
  const w = String(word).toLowerCase(), t = [];
  if (/p/.test(w)) t.push('P: اقفل شفايفك وافتحهم بنفخة هوا من غير صوت — مش B. جرّب ورقة قدام بقك لازم تتحرك.');
  if (/v/.test(w)) t.push('V: سنانك العليا على شفتك التحتانية وزنّ بصوت — مش F ومش B.');
  if (/th/.test(w)) t.push('TH: طرف لسانك بين سنانك. في this/that/the بصوت (ذ)، وفي three/think/thousand من غير صوت (ث) — مش ز ولا س.');
  if (/^(str|spr|spl|scr|sk|sp|st|sm|sn|sl)/.test(w)) t.push('ابدأ بالساكن على طول من غير ما تزوّد ألف قبله: "street" مش "إستريت".');
  if (/[^aeiou]ed$/.test(w)) t.push('ED في الآخر: بعد t/d تتنطق "إد" (tested)، وبعد p/k/s/sh/ch تتنطق "ت" (checked = تشِكت)، وغير كده "د" (filled).');
  if (/(tion|sion)$/.test(w)) t.push('TION بتتنطق "شِن" قصيرة: inspection = إنسبِكشِن.');
  if (/^(kn|wr)|mb$|ght|^h(our|onest)/.test(w)) t.push('فيه حرف ساكت مابيتنطقش: know (نو)، write (رايت)، climb (كلايم)، night (نايت)، hour (آور).');
  if (/(ee|ea|i[^aeiou])/.test(w) && !t.length) t.push('فرّق بين I القصيرة (sit, fill) وEE الطويلة (seat, feel) — طوّل أو قصّر الصوت.');
  if (/(o|u)/.test(w) && t.length < 2) t.push('الحركة القصيرة متطولهاش: "cut" = كَت، "pump" = بَمب (بصوت P).');
  if (/r/.test(w) && t.length < 2) t.push('R الإنجليزي من غير ترعيش: لسانك مايلمسش سقف بقك.');
  if (w.length > 7 && t.length < 3) t.push('كلمة طويلة: اضغط على مقطع واحد بس وخلّي الباقي خفيف، واسمعها بالبطيء.');
  return t.slice(0, 3);
}

// ---------- spaced repetition (Leitner boxes) ----------
const BOX_DAYS = [0, 1, 2, 4, 7, 14, 30, 60];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
export function srsAdd(S, key) { S.srs = S.srs || {}; if (!S.srs[key]) S.srs[key] = { box: 1, due: addDays(today(), 1) }; }
export function srsDue(S, max = 6) {
  const t = today();
  return Object.entries(S.srs || {}).filter(([, v]) => v.due <= t).sort((a, b) => a[1].due.localeCompare(b[1].due) || a[1].box - b[1].box).slice(0, max).map(([k]) => k);
}
export function srsGrade(S, key, ok) {
  const c = S.srs[key]; if (!c) return;
  c.box = ok ? Math.min(BOX_DAYS.length - 1, c.box + 1) : 1;
  c.due = addDays(today(), ok ? BOX_DAYS[c.box] : 1);
}
export function srsStats(S) {
  const v = Object.values(S.srs || {}); const t = today();
  return { total: v.length, due: v.filter(x => x.due <= t).length, strong: v.filter(x => x.box >= 5).length };
}

// ---------- course plan (British Council style: levels → units → classes) ----------
export const CLASSES_PER_WEEK = 3, LESSONS_PER_UNIT = 4, UNITS_PER_LEVEL = 9, TOTAL_LESSONS = 144;
export const CAN_DO = [
  ['أعرّف نفسي وشغلي وأتكلم مع الفورمان والمساح في مواقف يومية بسيطة.', 'أسأل عن التقدم والمشاكل وأرد بجمل واضحة.', 'أطلب حاجة مكتوبة وأتابع طلب دفع.'],
  ['أشرح أوامر التغيير وأختلف بأدب على كمية.', 'أدير مكالمة مع استشاري وأأكد الاتفاق.', 'أوصف مشكلة في الموقع وأقترح حل.'],
  ['أدافع عن قياساتي في اجتماع بالأرقام والأسباب.', 'أتفاوض على مواعيد وأسعار وأتابع المطالبات.', 'أقدّم تحديث أسبوعي منظّم.'],
  ['أقود اجتماع وأدير خلاف بثقة وطلاقة.', 'أعرض مطالبة أو تأخير بلغة عقدية واضحة.', 'أعمل مقابلة شغل كاملة بالإنجليزي.'],
];
export const globalIndex = (level, n) => level * 36 + n;          // 1..144
export const weekOf = g => Math.ceil(g / CLASSES_PER_WEEK);         // 1..48
export const unitOf = n => Math.ceil(n / LESSONS_PER_UNIT);         // 1..9 inside a level
export const TOTAL_WEEKS = Math.ceil(TOTAL_LESSONS / CLASSES_PER_WEEK);

// Weekly timetable (spacing + sleep + retrieval):
//   new-lesson days (default Sat/Mon/Wed 21:00): warm-up review + Way 1 of a new lesson
//   the day after each (Sun/Tue/Thu 21:00): Way 2 (no text, recall, free speaking) + lesson test
//   Friday: rest + short weekly review of mistakes. Commute: hands-free listening.
export const DEFAULT_SCHED = { days: [6, 1, 3], time: '21:00', review: 5 };
export const way2Days = sched => sched.days.map(d => (d + 1) % 7);
export function nextClasses(sched, from = new Date(), count = 3) {
  const out = []; const [hh, mm] = sched.time.split(':').map(Number); const w2 = way2Days(sched);
  for (let i = 0; i < 30 && out.length < count; i++) {
    const c = new Date(from); c.setDate(from.getDate() + i); c.setHours(hh, mm, 0, 0);
    const kind = sched.days.includes(c.getDay()) ? 'new' : w2.includes(c.getDay()) ? 'way2' : c.getDay() === sched.review ? 'review' : null;
    if (kind && c.getTime() > from.getTime() - 2 * 3600e3) out.push({ date: c, kind });
  }
  return out;
}
// Planned date of new lesson number g (1-based) counted from the course start.
export function plannedDate(sched, start, g) {
  const s = new Date(start + 'T00:00:00'); let k = 0;
  for (let i = 0; i < 900; i++) { const c = new Date(s); c.setDate(s.getDate() + i); if (sched.days.includes(c.getDay())) { k++; if (k === g) return c; } }
  return null;
}
export function classesBetween(sched, start, end = new Date()) {
  const s = new Date(start + 'T00:00:00'); let k = 0; const [hh, mm] = sched.time.split(':').map(Number);
  for (let c = new Date(s); c <= end; c.setDate(c.getDate() + 1)) { const t = new Date(c); t.setHours(hh, mm); if (sched.days.includes(c.getDay()) && t <= end) k++; }
  return k;
}
export const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY_ICS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const DAY_AR = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
export function icsFile(sched, start, weeks = TOTAL_WEEKS) {
  const p = n => String(n).padStart(2, '0');
  const [hh, mm] = sched.time.split(':').map(Number);
  const firstOn = days => { const s = new Date(start + 'T00:00:00'); for (let i = 0; i < 8; i++) { const c = new Date(s); c.setDate(s.getDate() + i); if (days.includes(c.getDay())) return c; } return s; };
  const t = (h, m) => `${p(h % 24)}${p(m)}00`;
  const ev = (uid, days, h, m, mins, title, desc) => {
    const d = firstOn(days), ds = ymd(d).replace(/-/g, ''); const e = h * 60 + m + mins;
    return ['BEGIN:VEVENT', `UID:${uid}-${start}@sitetalk`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;TZID=Asia/Riyadh:${ds}T${t(h, m)}`, `DTEND;TZID=Asia/Riyadh:${ds}T${t(Math.floor(e / 60), e % 60)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${days.map(x => DAY_ICS[x]).join(',')};COUNT=${weeks * days.length}`,
      `SUMMARY:${title}`, `DESCRIPTION:${desc}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'TRIGGER:-PT10M', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT'];
  };
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SiteTalk//EN', 'CALSCALE:GREGORIAN',
    ...ev('new', sched.days, hh, mm, 30, 'Site Talk — درس جديد (الطريقة 1)', 'مراجعة سريعة + الدرس الجديد بالنص والترجمة والتقليد.'),
    ...ev('way2', way2Days(sched), hh, mm, 20, 'Site Talk — الطريقة 2 + اختبار الدرس', 'نفس الدرس بأسلوب تاني: من غير نص + استرجاع + كلام حر، وبعدها الاختبار.'),
    ...ev('review', [sched.review], 20, 0, 15, 'Site Talk — مراجعة الأسبوع', 'راجع دفتر أخطائك والعبارات المستحقة.'),
    'END:VCALENDAR'].join('\r\n');
}
