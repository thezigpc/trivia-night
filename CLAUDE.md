# Trivia Night

A hosted trivia game module for the Bar Games box (game id `trivia`, port 3010). The brief
is [BRIEF.md](BRIEF.md); the user-facing overview is [README.md](README.md); the box
integration report is [BARGAMES.md](BARGAMES.md).

**The repo is public.** Never commit infrastructure details (hostnames, IPs, tunnel IDs, key
paths). Put them in a git-ignored `CLAUDE.local.md`.

## Rules from the brief

- **Don't edit** `C:\CodeProjects\GameBroker`, GameKit, the Leaderboard repo or other game
  modules.
  - Platform needs go to the GameBroker session as "SDK requests".
  - Leaderboard needs go through the GameBroker session too.
- **Don't touch the box.** The GameBroker session installs modules.
- **Ask the user** before creating GitHub repos or pushing.
- **Ship only original questions.** The sample pack (`server/assets/sample-pack.json`) and
  its SVG pictures were written for this game. Never add questions copied from published
  trivia games, books or websites.
- **Several sessions share this PC.** When testing, check ports first and stop only the
  processes you started (match by port and command line, never by name).

## Layout

- `shared/src/trivia.ts`: the pure rules.
  - The question and pack schema.
  - `normalizeAnswer` / `checkAnswer`: "correct", "close" (a near-miss for the host to
    accept) or "wrong".
  - The CSV/JSON pack parser, with per-row errors (`parsePack`, `cleanQuestion`), and
    `packToCsv`.
  - `teamKey` (case and spacing ignored, the way Tournament & Leaderboard joins seasons).
- `shared/src/protocol.ts`: socket events, `RoomView` (with `host` data for host and
  co-hosts only), `Screen`, `NightSpec`, errors.
- `server/src/rooms/Room.ts`: the state machine.
  - **What the TV shows** is `room.screen`, moved explicitly by the host: lobby, intro,
    question, answer, roundAnswers, standings, wager, over. That model serves both modes:
    paper sends things to the TV whenever the coordinator chooses; phones mode adds the
    answer timer on `ask`.
  - **Scores:**
    - `marks[qid][teamId]`: phones auto-mark, unless the host marked it by hand (`manual`).
    - `overrides[teamId][round]`: typed round totals.
    - `wagers`: the final counts only once revealed; a right answer adds the wager,
      anything else takes it away.
    - The tie-breaker's distance orders equal scores.
  - **What the TV shows as scores** is `published`: scores reach the TV only when someone
    sends them.
  - **Next button:** `suggestNext()` / `next()`.
  - **Results:** `finish()` reports results once (`bg.reportResults`, teams as players),
    emits `winner` and `game_over`, and records the teams in `content/teams.ts`.
- `server/src/rooms/plan.ts`: builds a night from a `NightSpec` (a round = pack + category +
  count; final from a pack's `use: final` question; tie-breaker from the night's packs, else
  any). The room keeps its own copy of the questions.
- `server/src/rooms/registry.ts`: the kit's `RoomRegistry`.
  - `createRoom` hands the night to the registry's `create` through a module-level `pending`,
    set synchronously around `rooms.create()`.
  - `createVenueRoom` is the box's `create_room`.
- `server/src/content/`:
  - `packs.ts`: the sample pack plus uploads in `DATA_DIR/packs.json`;
  - `pictures.ts`: uploads in `DATA_DIR/pictures`, PNG/JPEG/GIF/WebP only, sniffed, never SVG.
    The sample SVGs are in `server/assets/pictures`;
  - `teams.ts`: known teams in `DATA_DIR/teams.json`. `canonicalTeamName` gives the saved
    spelling.
- `server/src/admin/routes.ts`: the kit's admin auth and router.
  - The **upload router** (`/api/admin/upload/*`) is mounted *before* the kit's router,
    because the kit parses JSON with a 16 KB limit.
- `server/src/bargames.ts`: the only SDK connection (`wireBarGames` with `seats`, the
  commands and `create_room`).
- `client/src/pages/`:
  - `HomePage`: landing and join. `/join/CODE`, plus `?host=` and `?cohost=` links.
  - `HostPage`: `/host` setup.
  - `RoomPage`: picks the view by role. `?role=table` joins as a TV with no gesture.
  - `TeamView`: phones.
  - `TvView`: the table route.
  - `HostConsole`: the coordinator's console: questions and marking, the score grid, teams
    and co-hosts, setup.
  - `AdminPage`.
- `test/specs/`: `npm test` (build first). Each spec spawns its own server on a free port
  with a throwaway `DATA_DIR`. `05-bargames` runs against a fake box core.

## Conventions

- Storage keys start with `trivia_` (every game shares one origin on a box).
- Never write a bare `"/api/…"`: use `serverUrl` (`client/src/socket.ts`) or `basePath()`.
  The client is built with Vite `base: "./"` and served by the kit's `serveSpa`.
- **TV CSS:**
  - The root is `.tv.screen-<kind>`. Don't name it `tv-<kind>`: that collides with the inner
    blocks (`.tv-question`, `.tv-standings`), as happened once.
  - Sizes are in `vh`. Padding takes `--bg-safe-x/y` (tableMode).
  - Heights subtract `--bargames-announcement-top/-bottom`.
- **Standalone must keep working.** Box-only behaviour goes behind `bg.connected` or
  `isOnBox(venue)`.

## Testing like a box

Start the mock box from PowerShell, because Git Bash mangles `/trivia`. Use ports other
sessions aren't using:

```powershell
npx bargames mock-box . --game http://127.0.0.1:3010 --port 7090 --core-port 7190 --base /trivia
# then the game with BG_GAME_ID=trivia BG_CORE_URL=http://127.0.0.1:7190 BG_GAME_TOKEN=dev-token PORT=3010 BG_BASE_PATH=/trivia
npx bargames check --game http://127.0.0.1:3010
```

The browser walk-through used for 0.1.0 was a Playwright script in the session scratchpad. It
covers both modes, the TV at 1920×1080, phones at 390×844, admin, standalone and under
`/trivia`.
