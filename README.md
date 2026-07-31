# Fantasy Football Hub — 2026 Season

One link for the whole league — the deployment URL, nothing appended. Open it
and you're in: vote on the draft date, add your team, study a standard-scoring
draft board, see every game's kickoff time, and talk trash in one thread.

```
index.html        — the whole app (HTML + CSS + JS, no build step)
api/league.js     — serverless API for shared state
vercel.json       — deploy config
```

This folder is self-contained. Deploy it as its own Vercel project with
**Root Directory = `fantasy`** and it stands alone — nothing outside this
folder belongs to it.

## What's in it

| Tab | What it does |
|-----|--------------|
| 🏠 **Home** | Live countdown to the draft (or to kickoff), plus the season's key dates |
| 🏆 **Teams** | Every team with its logo and **all** of its co-managers. Claim yours here |
| 🗓️ **Draft Day** | The date poll *and* the draft order lottery |
| 📋 **Players** | The full draft-eligible pool, scored 1–10 with a target round |
| 📺 **Schedule** | All 18 weeks with kickoff times, TV networks, and bye weeks |
| 💬 **Clubhouse** | Trash talk, weekly awards, power rankings, and the league constitution |

Every tab is a big labelled button with its own icon — on a phone they sit in a
thumb-reachable bar along the bottom of the screen.

## The draft board

180 players are ranked by hand for **standard / non-PPR** — 55 WR, 53 RB, 26 QB,
18 TE, 12 K and 16 team defenses — each with who he is, previous teams, pros,
cons and when to take him.

Every player also carries:

- **Score, 1–10.** Derived from overall rank on a log curve rather than a
  straight line, because the gap between the RB1 and the RB6 is far larger than
  the gap between RB60 and RB65. Rank 1 scores 10, the end of round one is
  around 7.5, and deep bench names land near 3.
- **Round.** Recalculated live for your league size (8/10/12/14), shown with the
  pick range — "Rd 3 (25–36)".

**The rest of the pool fills itself in.** On load the board pulls every rostered,
draft-eligible player from Sleeper's public feed and appends anyone not already
ranked, tagged as undrafted so the tail is never mistaken for a ranking. Free
agents and non-fantasy positions are skipped. That feed is several megabytes, so
the result is cached for 24 hours and replayed from local storage after the
first visit.

Live data also corrects the ranked board — current team, age, experience,
college and injury designation — so a trade or an IR move fixes itself without a
code change.

## Teams and co-managers

A fantasy team is often run by more than one person, so a team here is a **name,
a logo, and a list of managers** rather than a single owner.

- Add a team with any number of people up front (`Isaac (Commissioner), Marcus`)
  — a role in parentheses is optional — or add them one at a time afterwards
  with a role picker.
- Everyone on a team carries a **role**: Commissioner, Treasurer, Trade rep,
  Draft host, Trash talk officer and so on, or anything you type. Change it from
  the dropdown on their chip and it saves immediately.
- Pick a logo from 24 emoji — it becomes the team's identity everywhere.
- Tap **This is my team** to attach yourself. Your name and logo then follow you
  onto your draft-date vote, your chat posts, and the draft order.
- Removing a team cleans up after itself: its votes, awards, ranking slot and
  lottery position all go with it.

The identity chip in the top bar always shows who the app thinks you are; tap it
to change.

## Draft order lottery

One tap draws a random order and reveals it last-pick-first. The shuffle runs
**on the server**, so everyone who opens the link sees the identical result —
a browser-side draw would hand each person a different answer and start exactly
the argument the lottery exists to prevent. Anyone can redraw, but it replaces
the order for the whole league and asks first.

## Clubhouse

- **Trash talk** — shared thread; each post is stamped with the author's team.
- **Weekly awards** — hand out "Week 3 · Highest score" style trophies to a team.
- **Power rankings** — reorder teams with arrows, add a note per team, publish.
- **Rules & money** — scoring, buy-in, payouts, last-place punishment, house
  rules. Anyone with the link can edit; settle it once so it isn't relitigated
  in week 9.

## On your phone

The hub is built mobile-first: bottom navigation, 48px minimum tap targets, and
no horizontal scrolling at 390px. On a computer the **⛶** button in the top bar
switches to full screen for draft night.

## One link, no setup

There is a single hub and a single link: the deployment URL itself. Nobody
creates a poll, nobody generates or forwards a private link, and there is
nothing to join.

The first person to open the site provisions the hub server-side with **every
day from Aug 5 to kickoff (Sep 9) already on the board** — 36 days. Everyone
after that lands in the same document: same dates, same teams, same chat.

The id is fixed (`HUB_ID = 'league'` in both `index.html` and
`api/league.js` — keep them in step). Older `?league=<id>` links still resolve,
so anything already shared keeps working.

## How the draft-date poll works

1. Add your team on the **Teams** tab, with everyone who's on it.
2. On **Draft Day**, pick your team from the dropdown.
3. Tap **every** day that works for you, then **Save my dates**.
4. The percentage under each day is the share of *teams* available then, so the
   highest percentage is the day the most of the league can actually make. The
   leader gets a 👑.
5. **Where the league stands** lists every day that got votes, best first, with
   the teams behind each one and who still owes a vote.
6. When you've decided, use **Lock it in**. The Home countdown retargets to
   draft day.

Voting is multi-select on purpose. Asking "which single date do you want" tends
to split a group across thirty-six options with no majority; asking "which days
can you make" finds the one that actually works.

**One vote per team, not per phone.** The vote is keyed by team, so a
three-person team can't outvote a solo manager, and any of its people can cast,
change, or withdraw it from any device. Selecting a team that has already voted
loads its current answer so you adjust it rather than silently replacing a
teammate's picks. **Withdraw my vote** takes the team off every day it picked.

## What gets saved

Everything shared lives server-side against the configured store, so it is the
same for everyone on the link and survives reloads and restarts:

league name · the Aug 5 → kickoff draft dates · every team's vote · the locked
draft date · every team with its logo · every person on each team and their
role · the drawn draft order · weekly awards · power rankings · the
constitution · every message on the board

Teams stay editable from the Teams tab after they're created: add a person,
change someone's role, drop a person, rename the team, or delete it outright.
Deleting a team also clears its vote, its awards, and its slot in the drawn
draft order rather than leaving dangling references.

The only thing kept per-device is which person *you* are, so the app knows whose
vote to update — that is deliberately local.

Until a storage driver is configured the API keeps this in memory and the UI
shows an amber warning, because a cold start would wipe it.

## Deploying

Create a new Vercel project from this repo and set **Root Directory** to
`fantasy`. The app then serves at the project root:

- `https://<project>.vercel.app/` — the hub
- `https://<project>.vercel.app/api/league` — the API

The Vercel **project name** is what appears in the URL, so name it
`fantasy-football-2027` and the shared link carries no other branding.

If the link needs to work for people without a Vercel account, set
**Settings → Deployment Protection → Vercel Authentication → Disabled**.
Preview deployments are protected by default and will show a login wall.

### Storage — required for votes to persist

Until you set storage env vars, the API keeps data **in memory**, which resets
whenever the function goes cold. The app shows an amber warning while it's in
that state. Pick one of these (both have free tiers):

**Option A — Upstash Redis (via Vercel Marketplace)**

Vercel's own KV product is now Upstash under the hood. In your Vercel project:
Storage → Marketplace → Upstash Redis → create a free database and connect it.
That injects the variables automatically. The handler reads:

```
KV_REST_API_URL           (or UPSTASH_REDIS_REST_URL)
KV_REST_API_TOKEN         (or UPSTASH_REDIS_REST_TOKEN)
```

Free tier is 256 MB and 10K commands/day — several orders of magnitude more
than a 12-person league will ever use.

**Option B — Supabase**

Create a project, run this once in the SQL editor:

```sql
create table leagues (id text primary key, data jsonb);
```

Then set in Vercel → Settings → Environment Variables:

```
SUPABASE_URL                 https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY    <service role key>
SUPABASE_TABLE               leagues        # optional, defaults to "leagues"
```

Upstash is checked first; Supabase is the fallback. Redeploy after adding
either set.

## Data, and how current it stays

- **Bye weeks** are baked in and confirmed for all 32 teams (Weeks 5–14, none
  in Week 12, Thanksgiving week). Week 11 is the heaviest with six teams off.
- **Game times** load live from ESPN's public scoreboard feed in the browser and
  cache for six hours, so scores and flexed kickoff times stay current all
  season. If the feed is unreachable the page falls back to the known Week 1
  slate and each week's date range.
- **Player rankings** are hand-written for the 2026 season and reflect standard
  scoring. **Sync live rosters** pulls current teams and injury designations
  from Sleeper's public API, so a trade or an IR move corrects the board without
  a code change.

Rankings are opinion. ADP moves weekly through August — sanity-check the top of
your board the day you draft.

## Why standard scoring changes the board

Receptions are worth zero, so the board is not the same one you'd see on ESPN
or Yahoo (which default to PPR):

- Workhorse rushers gain the most — **Jonathan Taylor** and **Derrick Henry** go
  earlier than their market ADP.
- Reception-dependent players lose real value — **Amon-Ra St. Brown** and
  **De'Von Achane** each slide roughly a full round.
- The **VAL** column is the gap between my standard rank and market ADP. Green
  means the market usually lets him fall past where he should go.

## Local development

```bash
python3 -m http.server 7430   # static only; the poll needs the API
```

For the poll and board you need the serverless function running, which means
`vercel dev` (or deploying). Without it, the Draft Guide and Schedule still work
fully — only the shared-state features need the backend.
