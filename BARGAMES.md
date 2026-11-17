# Bar Games integration: Trivia Night

**Level reached: 3** (hosted, branded, connected, controllable). It includes:
- `create_room` with `firstJoinerHosts`;
- hosting from the box (`host_link`, `cohost_link`, `remove_cohost`);
- the path prefix (`routing.basePath`);
- short room links (`joinPath`);
- `tableMode`, announcements and "← All games" / "← Box admin";
- results with teams as players.

- **SDK:** 0.16.0 (since 0.1.2), vendored at `vendor/bargames-sdk-0.16.0.tgz`.
- **GameKit:** 0.10.6 (since 0.1.2), vendored at `vendor/bargames-gamekit-0.10.6.tgz`.
- **Manifest:** [bargames.json](bargames.json), `trivia` 0.1.2, port 3010, image
  `ghcr.io/thezigpc/trivia-night:0.1.2`.

```
$ npx bargames validate .
! image: not pinned by digest; releases should use image@sha256:…
✓ trivia@0.1.0 (sdk level 3)

$ npx bargames check --game http://127.0.0.1:3010      (mock box --base /trivia --port 7090 --core-port 7190)
trivia@0.1.0 · level 3 · http://127.0.0.1:3010
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Trivia Night (mock)")
✓ /__bargames/theme.css served
✓ "room_closed" declared (the box takes a closed room off the TVs at once)
✓ status refuses requests without the game token
✓ status → 0 room(s)
✓ unknown commands are rejected
✓ command "start" is wired (and refuses a missing room)
✓ command "pause" is wired (and refuses a missing room)
✓ command "resume" is wired (and refuses a missing room)
✓ command "next_round" is wired (and refuses a missing room)
✓ command "end" is wired (and refuses a missing room)
✓ command "host_link" is wired (and refuses a missing room)
✓ command "cohost_link" is wired (and refuses a missing room)
✓ command "remove_cohost" is wired (and refuses a missing room)
✓ create_room → room BAVR (with hostUrl)
✓ status lists BAVR as a venue room
✓ table view /room/BAVR?role=table → 200
✓ host_link answers a new host link each time (take-over)
✓ cohost_link answers single-use invites that expire
✓ end closes BAVR
✓ BAVR left status after "end"

all checks passed
```

## Routes

| Route | What |
|---|---|
| `player: "/"` | Phones mode: a team joins with the room code and its name. `/join/CODE` (the QR code, the status `joinPath`, the box's short room link) pre-fills the code |
| `table: "/room/{code}?role=table"` | The TV. The URL alone joins as a display: no name, no tap |
| `host: "/host"` | The coordinator: sets up a night (phones or paper, rounds from packs) and opens the room. The console runs at `/room/CODE` |
| `admin: "/admin"` | Question packs (CSV/JSON), pictures, known teams, defaults, open rooms |

## Events

Every event carries `roomCode` and `sessionKind`. Off a box nothing is sent.

| Event | Emitted at | `data` |
|---|---|---|
| `room_created`, `room_closed`, `players_changed` | The kit's `wireBarGames`, from the registry. `room_closed` fires on every way a room closes: host, `end`, admin, idle, error, shutdown | as the kit sends them. `players` = teams |
| `round_started` | `Room.intro()`, `server/src/rooms/Room.ts:442` (the first time each round's title goes up) | `{ round, title, questions, mode }` |
| `round_ended` | `Room.showStandings()`, `Room.ts:565` (the first scores after every question of a round was asked) | `{ round, title, leader: { name, score } }` |
| `winner` | `Room.reportResults()`, `Room.ts:685`, at **Finish the night** | `{ name, teams: [names], score }`. Joint winners: `name` is "A & B" |
| `game_over` | `Room.ts:690`, right after `winner` | `{ winners: [names], teams }` |
| `game_result` | The SDK, from `bg.reportResults()`, `Room.ts:680` | See "Results" |
| `x-trivia-question` | `Room.ask()`, `Room.ts:458` (first time a question is shown) | `{ round: n \| "final" \| "tiebreaker", number, category }` |
| `x-trivia-answer-revealed` | `Room.reveal()`, `Room.ts:515` | `{ round, number, answer, correct, teams }` |
| `x-trivia-round-answers` | `Room.revealRound()`, `Room.ts:544` | `{ round, questions }` |
| `x-trivia-standings` | `Room.showStandings()`, `Room.ts:555` (each time scores go to the TV) | `{ label, top: [{ name, score, place }] }`, top 3 |

- **Not emitted:** `claim_pending` (trivia has no claims).
- **Privacy:** `data` holds only team names that people typed, plus question data. A test
  checks that no event carries a seat token or an IP.

## Results: teams as players

At **Finish the night**, `bg.reportResults({ roomCode, results })` is sent once per room. Each
team is one player:

```json
{ "player": { "name": "The Smarty Pints", "team": true }, "place": 1, "score": 12 }
```

- **Teams are marked** with `player.team: true` (SDK 0.16.0, since 0.1.2), so boards such as
  Tournament & Leaderboard 0.4.1 keep team seasons apart from individual players.
- **Places:** equal scores share a place, unless the tie-breaker separated them.
- **Stable names:** a team's name is the venue's saved spelling. Every team that finishes a
  night is kept in `DATA_DIR/teams.json`. When teams are created (a phone joining, or the
  coordinator adding a paper team), the form offers "Played here before", and a typed name
  that matches one, ignoring case and spacing, takes the saved spelling.
- **Why it matters:** "quiz  KHALIFA" next week is reported as "Quiz Khalifa", so Tournament &
  Leaderboard's seasons (which join by name, ignoring case and spacing) keep the team
  together. Staff can rename or merge misspelt teams in the admin.

## Commands

All are in `server/src/bargames.ts`, wired through the kit's `wireBarGames`. Each runs the
same `Room` method as the host's button, then broadcasts. Refusals come back as
`{ ok: false, message }` in the game's own words.

| Command | Room method | Refused when |
|---|---|---|
| `create_room` | `createVenueRoom`: a `venue` room with the admin's defaults (mode, timer) and the default night (the newest uploaded pack, else the sample), and an empty "Venue" host seat. `hostUrl` = `/join/CODE?host=<key>` opens the console. `firstJoinerHosts`: the first phone in becomes the host; the offer closes on **any** attach to the host seat (kit `HostSeats`) | Room cap |
| `start` | `room.start()`: round 1's title goes up | Unknown room; already started |
| `pause` / `resume` | `room.setPaused()`: freezes or restarts the answer timer; the TV shows "Paused" | Not started or finished; already paused / not paused |
| `next_round` | `room.nextRound()`: the next round's title; after the last round, the final's wagers | Not started; nothing left ("This is the last round.") |
| `end` | The kit closes the room with "The host closed this trivia night." (cause `host`) | Unknown room |
| `host_link` | Kit `HostSeats.takeover()` + `Room.takeOver()`: a new host key; the old host's phone stays on as a co-host and is told so | Unknown room |
| `cohost_link` | Kit `HostSeats.invite()`: a single-use, expiring `/join/CODE?cohost=<token>` | Unknown room |
| `remove_cohost` | `Room.demoteCohost()`: the co-host's device is told and leaves | Unknown room or member |

**Status:** the kit's `overviews()`.
- `players`: the number of teams.
- `phase`: `lobby` / `playing` / `over`.
- `round`.
- `title`, e.g. "Tuesday Quiz · Round 2: Science & Nature · Q3 of 8" or "Lobby (paper)".
- `hostName` and `hostConnected`.
- `tables`: TVs.
- `maxPlayers`: 60.
- `joinPath`: `/join/CODE`, venue and patron rooms only.

## The table (TV) view

The route is `/room/{code}?role=table`. Every item below was checked in headless Chromium at
1920×1080, through the mock gateway under `/trivia`.

- [x] **The URL alone joins as a display.** No name or tap. It joins as `table` and keeps the
      seat in this tab's storage.
- [x] **No audio.**
- [x] **Fills 1920×1080 with no scrolling** on every screen: lobby, round title, question
      (open, multiple choice, picture), answer, round answers, scores, wagers, paused, final
      scores.
  - Text: the question is 3.8–7.2vh by length, and the answer 8vh. The smallest text is
    "Join at" and labels, at 2.6–3vh.
  - Margins: `tableMode`'s `--bg-safe-x/y` on a box.
- [x] **Recovers by itself.** The kit's `useRoomConnection` resumes on every connect. A
      closed room shows the game's name and the reason. On a box, `tableMode` shows the
      standard "Reconnecting…" / closed banners.
- [x] **Light on animation:** only the timer ring's stroke moves (`prefers-reduced-motion`
      stops it).
- [x] **Nothing needs a pointer.** The TV has no buttons. The host's console, co-hosts or the
      box's iPad move it from screen to screen.
- **Phones mode** shows the join QR and the short room link in the lobby (the kit's
  `JoinBox`, `joinDisplay(...).roomShort ?? short`), and the room code during play.
- **Paper mode** shows no QR, no code, no timer and no "answered" counts. The lobby says
  "Grab an answer card and a pen".
- **Branding:** the venue's colors, font and radius via `--venue-*`, with the game's own as
  fallback. The venue logo appears next to the name on a box.
- **Announcements:** the kit's `<VenueAnnouncement>` at the root, following `show` and
  `position`. The TV height subtracts the strip.

## Container

- **Image:** `node:22-slim`. `vendor/` is copied before `npm ci`. It runs as `USER node`, and
  `/data` is owned by `node`.
- **Writes:** only `DATA_DIR` (`/data`), with atomic writes through the kit's JSON store.
  Logs go to stdout. The server makes no outbound calls.

  | File | What |
  |---|---|
  | `admin.json` | The admin password hash, if set on the setup screen |
  | `settings.json` | Defaults for new rooms; idle time |
  | `packs.json` | Uploaded question packs |
  | `pictures/*` | Uploaded pictures (PNG/JPEG/GIF/WebP, sniffed; SVG refused) |
  | `teams.json` | Known teams |

- **Read-only run:** not tested. Docker isn't installed on the dev PC; the publish workflow
  is the clean-checkout build. `package-lock.json` has the Linux x64 native builds (esbuild,
  rollup).

## Standalone

With no `BG_*` env:
- the SDK is a no-op;
- the game uses its own name and colors;
- `/__bargames/status` and `/__bargames/command` answer 401;
- `venue.json` says `standalone: true`;
- `BackToGames`, `BoxAdminLink`, `tableMode` and the venue logo render nothing.

The same browser walk-through passed standalone at the root (`http://localhost:<port>/`).

## Tests

`npm test`: **31 tests, all pass** (0.1.2).

| Spec | Covers |
|---|---|
| `01-rules` | Answer matching, CSV/JSON packs with row errors, the sample pack, team-name keys |
| `02-phones` | Joining, auto-marking, near-misses, reveals, standings, the wager final, the tie-breaker, answers after the round, pause |
| `03-paper` | No phones; coordinator marks, typed totals, wagers, tie-breaker guesses; co-hosts |
| `04-admin` | Packs, pictures, known teams (stable spelling, merge), settings |
| `05-bargames` | Standalone; commands; status; events; `game_result`; `create_room`; first joiner hosts; host_link / cohost_link / remove_cohost |

**Browser:** a Playwright walk-through, run twice: on the mock box under `/trivia`, and
standalone. It covered:
- host setup;
- the console;
- the TV in every screen;
- two team phones answering open and multiple-choice questions and wagering;
- a paper night (teams, marking, the score grid, scores to the TV);
- a phone visiting a paper room;
- the admin through staff sign-in;
- the landing page.

The results: no page errors, no 4xx/5xx, no request outside `/trivia`, and the TV never
scrolls.

## On-screen keyboard (0.1.1; GameKit 0.10.6 since 0.1.2)

Box 0.21.0 touchscreens have no keyboard, so the kit's `<OnScreenKeyboard />` is mounted once at
the root (`client/src/main.tsx`). One app covers every page: join, host setup, the console, the
TV (which has no fields) and the admin. Phones, tablets and PCs never see it.

**Every field:**
- is a real `<input>` or `<textarea>` with `maxLength`;
- sits in a `<form>`, so Enter works. Fields that save on blur (score cells, guesses, wagers
  typed by the coordinator, timers) use `EnterForm`, where Enter finishes the field and closes
  the keyboard.

**Number fields** (wagers, tie-breaker answers, score cells, timers, question counts) are
`NumInput`: `type="text"` with `inputMode` (`numeric`, or `decimal` where "." is allowed), as the
kit's README advises. On phones that brings up their own number keyboard; on keyboard screens,
the kit's number pad. 0.1.1 switched to `type="tel"` while the keyboard was up, to get around a
kit bug that 0.10.3 fixed; 0.1.2 drops that workaround.

**Dropdowns** (kit 0.10.6): on keyboard screens, tapping a `<select>` opens the kit's
big-button list, titled with the field's label. Chromium's own pop-up can't be reached by
touch there. Trivia's dropdowns are all labelled: setup, the night builder's pack and
category, the console's settings, and the admin defaults.

The number fields used to snap to their minimum when cleared. They now keep the typed text, so
backspace-and-retype works.

**Nothing is covered.**
- The kit pads the page bottom.
- The only fixed bottom element is the error toast, which moves to the top on keyboard screens
  (`useOnScreenKeyboard()`).
- A browser check confirmed that the focused field is above the keyboard every time, and that
  nothing fixed or sticky overlaps it.

**Checked** (scratchpad `e2e-keyboard.cjs`, mock box under `/trivia`, `?bg_keyboard=1`, every key
tapped on the on-screen keyboard, at 1920×1080 and 3840×2160):
- Host setup: the title, the timer (number pad, backspace and retype) and a round's question
  count; Enter doesn't reload the page. Two dropdowns (when answers go up, and a round's
  category) open the kit's list, and the choice sticks (0.1.2).
- A team joins from a kiosk: the room code and team name, then Enter.
- An open answer sent with Enter. The answer box is focused automatically and opens the
  keyboard by itself (kit 0.10.5, checked in 0.1.2).
- The tie-breaker on the number pad, including ".".
- A wager: too big gives a toast, shown above the keyboard; then a valid one.
- The console's score grid: the number pad, and Enter saves.
- Adding a team.
- The admin sign-in, submitted with Enter.
- `?bg_keyboard=0` turns it off.

Phones at 390 px without the flag show no keyboard, no padding and the same width. The 0.1.0
walk-through still passes (re-run for 0.1.2).

At 4K with a 1× device scale, the page keeps its CSS size, so it looks small, while the keyboard
fills the width. A 4K touchscreen normally runs at 2× scale.

## SDK requests

0. **Done in GameKit 0.10.3, adopted in 0.1.2. Numeric fields got letters (0.10.0-0.10.2).** `OnScreenKeyboard` sets `inputmode="none"` on
   focus and saves the original in `data-bg-inputmode`, but `wantsNumberPad()` reads
   `getAttribute("inputmode") ?? dataset.bgInputmode`. `"none"` isn't null, so the saved mode is
   never read: every `inputMode="numeric"`/`"decimal"` field gets the letter keyboard. Only
   `type="number"`/`"tel"` get the number pad. Fix: read `dataset.bgInputmode` first, or treat
   `"none"` as unset. The focus handler also never puts the original `inputmode` back on blur.
   Trivia 0.1.1 worked around it with `type="tel"` while the keyboard was up.
1. **Done in GameKit 0.9.0, adopted in 0.1.2: `adminRouter`'s body limit.** The uploads
   (`/api/admin/upload/*`) now sit on the kit's router with `bodyLimit: "6mb"`, and a test
   uploads a pack of over 30 KB. The original request: It parses every request with
   `express.json({ limit: "16kb" })`, so a game's own admin routes that take uploads
   (question packs, pictures) can't hang off it. Trivia mounts its own upload router ahead of
   it, with its own session check. An option (`bodyLimit`, or not parsing bodies for routes
   added after the kit's) would save the next game the workaround.
2. **Done in SDK 0.16.0, adopted in 0.1.2 (`player.team: true`). Team results.** `reportResults` had no way to say the "players" are teams. A
   `player.kind: "team"` (or `team: true`) would let Tournament & Leaderboard keep team
   seasons apart from individual boards, and label them.
3. **Reading results**, for automatic season import. Already queued, per the GameBroker
   session.
4. **Rooms are in memory**, as in every game so far. A container restart (update, memory
   limit) ends a trivia night mid-game and loses its scores, which is worse here than in
   Bingo. Persisting a room snapshot to `/data` is the game's job; noted for a later
   version. A box-side "don't update while a room is playing" guard would help every game
   (box 0.19.0 now refuses an update while a room has players).
