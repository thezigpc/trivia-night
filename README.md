# Trivia Night

A hosted trivia night for the Bar Games box, which also runs on its own. A host (and
co-hosts) runs rounds of questions. The TVs show the questions, the timer, the answers and
the scores. Teams play one of two ways, chosen per room:

| Mode | How teams answer | How scoring works |
|---|---|---|
| **Phones** | Each team joins from one phone (a QR code on the TV) and answers before the timer runs out | Exact, multiple-choice and true/false answers mark themselves. Near-misses ("Lincoln" for "Abraham Lincoln", a typo) are flagged for the host, who accepts or rejects them |
| **Paper** | Teams write on answer cards, as at a classic quiz night. No phones, and no QR code on the TV | The coordinator marks the cards on a tablet or phone, or types round totals, and sends answers and scores to the TV whenever they choose: per question, per round, or all at once |

## Running a night

1. **Set up** at `/host`:
   - Pick phones or paper.
   - Build the night by round: "Round 1: General (10 questions), Round 2: Music, Round 3: Pictures, Final". Questions come from the venue's packs.
   - Choose when answers go up: after each question, or after the round.
   - Open the room.
2. **Open the TV screen**, from the console's 📺 button: `/room/CODE?role=table`. On a Bar
   Games box, the box casts it.
3. **Run it** from the console. The big **▶ Next** button follows the usual order:

   > round title → question → close answers → answer → … → scores → next round → final wagers → final → scores → tie-breaker (only for a tie at the top) → finish

   Every question also has its own **Show** and **Answer** buttons, and every round has
   **Show title** and **Show all answers**.
4. **Mark answers.** Open a question to see each team's answer with ✓ / ✗.
5. **Keep score.** The **Scores** tab has a round × team grid. Type a number to set a round's
   total by hand; clear it to go back to the marks. **Send scores to TV** puts the current
   standings up.
6. **The final** is a wager round:
   - Teams bet up to their score, on their phones or on their card.
   - On paper, the coordinator types each wager.
   - A right answer adds the wager; a wrong one (or no answer) takes it away.
7. **The tie-breaker** is a number question ("closest to"). On paper, the coordinator types
   each team's guess. It decides the order between equal scores.
8. **Co-hosts** mark answers and run the screens from their own device (Teams tab → Add a
   co-host, a single-use QR code). Only the host can remove teams or co-hosts, or close the
   room.
9. **Finish the night.** The final scores and the winner go up on the TV, and the results go
   to the venue's leaderboard, with teams as players under their own names.

**Returning teams:** every team that finishes a night is remembered. When a team joins (phone)
or is added (paper):
- the form offers the names used here before;
- a name that matches one, ignoring case and spacing, takes its saved spelling.

That keeps a team's season results under one name.

## Question packs (admin, `/admin`)

Upload packs as CSV or JSON. Every problem is reported with its row before anything is saved.

| Column | |
|---|---|
| `question`, `answer` | Required |
| `accept` | Other answers that count, separated by `\|` |
| `type` | `open` (default), `choice`, `truefalse` or `number` |
| `choices` | The options of a multiple-choice question, separated by `\|`. The answer is one of them, or its letter |
| `category` | Groups questions into rounds |
| `points` | Default 1 |
| `image` | A picture uploaded in the admin (its file name), or an https link |
| `note` | Shown to the host only |
| `use` | `round` (default), `final` (the wager question) or `tiebreaker` (a number question) |

Only an **original sample pack** ships with the game: four short rounds, a final and a
tie-breaker, written for it, with its own drawn pictures. Write or license your own questions;
don't upload questions copied from published quiz games, books or websites.

The admin also holds:
- the pictures for picture rounds;
- the list of known teams (rename a misspelt team onto the right name to merge them);
- the defaults for new rooms;
- the open rooms.

## Development

```bash
npm install
npm run dev          # server on :3010, Vite client on :5180
npm run build && npm test
```

- **Layout:** npm workspaces:
  - `shared/`: rules and protocol;
  - `server/`: Express, socket.io and the room state machine;
  - `client/`: React and Vite;
  - `test/`: node:test specs, each spec on its own throwaway server.
- **Data:** the server writes only to `DATA_DIR` (default `./data`): the admin password hash,
  settings, packs, pictures and known teams.
- **Bar Games:** level 3. See [BARGAMES.md](BARGAMES.md).

## Docker

```bash
docker build -t trivia-night .
docker run --rm -p 3010:3010 -v trivia-data:/data trivia-night
```

The image runs as `node` (uid 1000) and writes only to `/data`.
