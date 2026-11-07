# Site Talk English

Offline English speaking & pronunciation trainer for site engineers and quantity surveyors (earthworks).

- 4 levels (B1, B1+, B2, B2+) × 36 lessons, each with dialogue + Arabic translation, key phrases, pronunciation corner.
- Lesson test after every lesson (read-aloud accuracy, speaking tasks, fluency). The next lesson unlocks only after mastery.
- Session length grows from 2 to 30 minutes after consistent mastery; speech speed rises with the lessons and levels.
- Level test after 36 mastered lessons; 100% required to move up.
- Speech recognition runs in the browser (Whisper, ONNX Runtime Web) — no internet needed after the first download.

The app is the static site in this folder (GitHub Pages). `src/` holds the lesson sources and build scripts.

## v2 — course structure (Nov 2026)
- British Council-style plan: 4 levels → 36 units (4 lessons each) → 144 lessons, ~48 weeks at 3 new lessons a week; CEFR can-do goals per level; unit test every 4 lessons (recall, minimal-pair pronunciation, 4/3/2 fluency).
- Every lesson is done twice in two different ways before the test unlocks: Way 1 (understand & imitate, with text) and Way 2 the next day (no text, Arabic→English recall, the other role, 4/3/2 fluency). The dialogue must be heard to the end before moving on.
- Per-word pronunciation score (0–100) from the offline Whisper model (teacher-forced probability of each reference word), tap any weak word for a slow model, tips for Arabic speakers and a single-word retry.
- Rule-based correction of common grammar errors in free speaking, with the corrected sentence ("recast").
- Spaced repetition (1/2/4/7/14/30/60 days) of every mastered phrase, mistakes notebook, site missions, commute (hands-free) mode, site phrasebook, class reminders (.ics calendar export + in-app notifications).
