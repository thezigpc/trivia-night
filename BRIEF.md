# Trivia Night for the Bar Games box: brief

**You are building a game module** for the Bar Games box. The platform lives in
`C:\CodeProjects\GameBroker` (public repo thezigpc/venueplay).

**What it is:** hosted trivia night. A host (and co-hosts) runs rounds of questions. The TVs
show the questions, timers, answer reveals and standings. Teams play one of two ways, chosen
per room:

| Mode | How teams answer | How scoring works |
|---|---|---|
| **Phones** | Each team joins from a phone (QR on the TV) and submits answers before the timer ends | Automatic for exact or multiple-choice answers; the host or a co-host can accept near-misses ("Abe Lincoln" for "Abraham Lincoln") |
| **Paper** (no phones allowed) | Teams write on answer cards, like a classic quiz night. Many trivia hosts run it this way, and some venues ban phones during trivia to stop searching | The coordinator collects the cards, marks them on their own device (tablet or phone), and **sends answers and scores to the TV** when they choose: per question, per round, or all at once |

Paper mode is a first-class mode, not an afterthought: the coordinator's screen is the whole
game. It holds the question list, a "show on TV" button for each question and each answer,
a team list with a score grid (round × team) and the standings. Nothing needs players' phones.

**Read first:**
- `C:\CodeProjects\GameBroker\docs\SDK.md`: the SDK guide (manifest, routes, base path,
  theming, events, levels, hosting from the box).
- `C:\CodeProjects\GameBroker\integration\README.md`: vendoring the SDK tarball (0.14.0 or
  newer) and what's new in each SDK version.
- **A hosted game to copy patterns from:** `C:\CodeProjects\BingoDigitalGame` (0.9.0+): rooms,
  the TV view, `HostSeats` (host, co-hosts, take-over), `wireBarGames`, JoinAddress and short
  room links, Docker and the publish workflow. Read its `CLAUDE.md` and `BARGAMES.md`. Don't
  edit it.
- **GameKit:** `C:\CodeProjects\GameKit` (`CHANGELOG.md`): rooms, admin login, HostSeats,
  JoinAddress, React plumbing. Use it instead of hand-rolling those.

**Don't edit anything under `C:\CodeProjects\GameBroker`,** GameKit or the other modules.
Send platform needs to the GameBroker session as "SDK requests".

## What to build (0.1.0)

**Manifest:**
- **Basics:** `id: "trivia"`, `name: "Trivia Night"`, `kind` game, `port: 3010`,
  `routing.basePath: true`, SDK level 3.
- **Routes:**
  - `player: "/"`: phones mode, the team's answer page;
  - `table: "/room/{code}?role=table"`: the TV;
  - `host: "/host"`: the coordinator's console;
  - `admin: "/admin"`: question packs and settings.
- **Commands:**
  - `create_room` (honour `firstJoinerHosts`);
  - `start`, `pause`, `resume`, `next_round`, `end`;
  - `host_link`, `cohost_link`, `remove_cohost`, through GameKit's `HostSeats` and
    `wireBarGames({ seats })`.
- **Events:**
  - standard: `round_started`, `round_ended`, `winner`, `game_over`;
  - custom, with the `x-trivia-` prefix: e.g. `x-trivia-answer-revealed`, `x-trivia-standings`.

  The box can flash the lights on `winner` and run scenes on them.
- **Results:** `bg.reportResults()` at the end of a game, with **teams as players** (name,
  place, score). Those feed the venue's leaderboard and **season standings** (see "Leaderboard
  and tournaments" below).

**Questions:**
- **The venue's own question packs,** uploaded in the admin as CSV or JSON. Each question has:
  - question text, answer, and accepted alternatives;
  - type: open answer, multiple choice or true/false;
  - category, points, an optional picture (picture rounds), and an optional "host note".
- **Ship only an original sample pack.** Never ship questions copied from published trivia
  games, books or websites. Write a short sample yourself, as No Filter does for its starter
  cards.
- **Game setup:** pick a pack, or build the night from several packs by round ("Round 1:
  General, Round 2: Music, Round 3: Pictures, Final").

**Game flow:**
- **Rounds of N questions,** each with a timer (phones mode) or with no timer (paper mode,
  where the coordinator moves on).
- **Reveals:** answers show on the TV after each question or after the round, as the host chooses.
- **Standings:** on the TV between rounds, with the top teams highlighted.
- **Optional final round:** a wager question. Teams bet part of their points; on paper the
  coordinator enters the bets.
- **Tie-breaker:** a numeric "closest to" question.
- **Co-hosts:** they mark answers and run the screens (a second staff member scoring paper
  cards). Only the host can end the room or remove people, as `HostSeats` defines.

**TV:**
- **Shown:** large, readable text; the question, choices, the timer, the reveal, standings,
  and the join QR plus short room link (phones mode only; paper mode shows no QR).
- **Venue extras:** follow the venue's theme and announcement banner, like Bingo's table view.

## Leaderboard and tournaments (build alongside)

The Leaderboard app (`C:\CodeProjects\Leaderboard`) is becoming **Tournament & Leaderboard**:
brackets, plus links to compatible games. For trivia that means:
- **Seasons:** standings across weeks (trivia leagues). They're built from `game_result`, so
  report results with stable team names.
- **Team identity:** teams return weekly. Offer "pick an existing team" when creating teams,
  so standings don't split on spelling.

Coordinate with the Leaderboard session through the GameBroker session. Don't edit the
Leaderboard repo yourself.

## Reporting back

When 0.1.0 is published (repo `thezigpc/trivia-night` or a name the user picks, public image
`ghcr.io/thezigpc/trivia-night:<version>`), reply to "GameBroker Session" with:
- the version, commit and publish run;
- tests;
- what each mode looks like;
- anything you need from the platform (SDK requests).

Ask the user before creating the GitHub repo. Don't touch the box: the GameBroker session
installs modules.
