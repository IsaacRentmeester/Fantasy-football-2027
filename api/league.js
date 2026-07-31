/**
 * League API — shared storage for the Fantasy Football Hub.
 *
 * Handles the draft-date poll and the league message board. Zero npm
 * dependencies: uses the global fetch built into Vercel's Node runtime.
 *
 * Storage is pluggable and auto-detected from environment variables, in
 * priority order:
 *
 *   1. Upstash Redis / Vercel KV
 *        KV_REST_API_URL + KV_REST_API_TOKEN
 *        (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 *   2. Supabase
 *        SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)
 *        Requires a table:
 *          create table leagues (id text primary key, data jsonb);
 *   3. In-memory — ephemeral, resets whenever the function goes cold.
 *      Fine for kicking the tires, useless for a real league. The API
 *      reports this back so the UI can warn.
 */

'use strict';

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
// Accept either the base project URL or the REST endpoint — Supabase's dashboard
// shows both, and pasting the longer one would otherwise double the /rest/v1 path.
const SB_URL = (process.env.SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/i, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SB_TABLE = process.env.SUPABASE_TABLE || 'leagues';

const DRIVER = KV_URL && KV_TOKEN ? 'kv' : SB_URL && SB_KEY ? 'supabase' : 'memory';

// Guardrails so one bad actor can't balloon a document.
const LIMITS = {
  dates: 60,
  voters: 200,
  messages: 400,
  name: 40,
  text: 800,
  leagueName: 60,
  teams: 32,
  managers: 12,
  teamName: 44,
  awards: 200,
  rules: 4000,
  emoji: 8,
  role: 28,
};

const memory = new Map();

/* ---------------------------------------------------------------- storage */

async function readRaw(key) {
  if (DRIVER === 'kv') {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) throw new Error(`kv get failed: ${r.status}`);
    const j = await r.json();
    return j.result == null ? null : j.result;
  }

  if (DRIVER === 'supabase') {
    const url = `${SB_URL}/rest/v1/${SB_TABLE}?id=eq.${encodeURIComponent(key)}&select=data`;
    const r = await fetch(url, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) throw new Error(`supabase select failed: ${r.status}`);
    const rows = await r.json();
    if (!rows.length) return null;
    const d = rows[0].data;
    return typeof d === 'string' ? d : JSON.stringify(d);
  }

  return memory.has(key) ? memory.get(key) : null;
}

async function writeRaw(key, value) {
  if (DRIVER === 'kv') {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: value,
    });
    if (!r.ok) throw new Error(`kv set failed: ${r.status}`);
    return;
  }

  if (DRIVER === 'supabase') {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{ id: key, data: JSON.parse(value) }]),
    });
    if (!r.ok) throw new Error(`supabase upsert failed: ${r.status} ${await r.text()}`);
    return;
  }

  memory.set(key, value);
}

const docKey = (id) => `ffhub:league:${id}`;

/**
 * Fill in fields added after a league was first created, so documents written
 * by an older deploy keep working instead of throwing on a missing array.
 */
function normalize(doc) {
  if (!Array.isArray(doc.dates)) doc.dates = [];
  if (!doc.votes || typeof doc.votes !== 'object') doc.votes = {};
  if (!Array.isArray(doc.messages)) doc.messages = [];
  if (!Array.isArray(doc.teams)) doc.teams = [];
  // Upgrade pre-roles teams (managers were bare strings) in place.
  doc.teams.forEach((t) => {
    if (!Array.isArray(t.managers)) { t.managers = []; return; }
    t.managers = t.managers.map((m) =>
      typeof m === 'string' ? { name: m, role: 'Manager' } : m).filter((m) => m && m.name);
  });
  if (!Array.isArray(doc.awards)) doc.awards = [];
  if (doc.locked === undefined) doc.locked = null;
  if (doc.order === undefined) doc.order = null;
  if (doc.power === undefined) doc.power = null;
  if (!doc.rules || typeof doc.rules !== 'object') {
    doc.rules = { scoring: '', dues: '', payouts: '', punishment: '', notes: '' };
  }
  return doc;
}

async function loadLeague(id) {
  const raw = await readRaw(docKey(id));
  if (!raw) return null;
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Read → mutate → write, with an optimistic version check.
 *
 * The REST APIs behind both drivers are stateless, so there is no true
 * compare-and-swap available here. Re-reading and retrying on a version bump
 * closes the common window (two people voting at once) without pretending to
 * be atomic. For a friends' league that is the right trade.
 */
async function mutate(id, fn) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await loadLeague(id);
    if (!doc) return { error: 'not_found' };

    const before = doc.v || 0;
    const result = fn(doc);
    if (result && result.error) return result;

    doc.v = before + 1;
    doc.updated = Date.now();

    const current = await loadLeague(id);
    if (current && (current.v || 0) !== before) {
      lastErr = 'conflict';
      continue; // Someone else wrote first — rebuild on top of their version.
    }

    await writeRaw(docKey(id), JSON.stringify(doc));
    return { league: doc };
  }
  return { error: lastErr || 'conflict' };
}

/* ------------------------------------------------------------- validation */

// Strip control characters (they break rendering and JSON), keep everything else.
const clean = (s, max) =>
  typeof s === 'string' ? s.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max) : '';

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z'));

const newId = () =>
  (Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)).toLowerCase();

/* ---------------------------------------------------------------- actions */

function doCreate(body) {
  const dates = Array.isArray(body.dates) ? body.dates.filter(isDate).slice(0, LIMITS.dates) : [];
  return normalize({
    id: newId(),
    v: 0,
    name: clean(body.name, LIMITS.leagueName) || 'Fantasy Football 2027',
    created: Date.now(),
    updated: Date.now(),
    dates: [...new Set(dates)].sort(),
  });
}

const findTeam = (doc, id) => doc.teams.find((t) => t.id === clean(id, 40));

/**
 * Co-managers as {name, role}, de-duplicated case-insensitively.
 *
 * Accepts bare strings too, so team documents written before roles existed
 * upgrade in place on the next read instead of breaking.
 */
function cleanManagers(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((m) => {
    const isStr = typeof m === 'string';
    const name = clean(isStr ? m : (m && m.name), LIMITS.name);
    const role = clean(isStr ? '' : (m && m.role), LIMITS.role);
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push({ name, role: role || 'Manager' });
  });
  return out.slice(0, LIMITS.managers);
}

const findManager = (team, name) => {
  const n = clean(name, LIMITS.name).toLowerCase();
  return team.managers.find((m) => m.name.toLowerCase() === n);
};

const ACTIONS = {
  vote(doc, body) {
    const voter = clean(body.voter, 40);
    const name = clean(body.name, LIMITS.name);
    if (!voter || !name) return { error: 'voter and name required' };

    const picks = Array.isArray(body.picks)
      ? [...new Set(body.picks.filter((d) => isDate(d) && doc.dates.includes(d)))]
      : [];

    if (!doc.votes[voter] && Object.keys(doc.votes).length >= LIMITS.voters) {
      return { error: 'voter limit reached' };
    }
    const team = findTeam(doc, body.teamId);
    doc.votes[voter] = { name, teamId: team ? team.id : null, picks, ts: Date.now() };
  },

  unvote(doc, body) {
    const voter = clean(body.voter, 40);
    if (voter) delete doc.votes[voter];
  },

  addDates(doc, body) {
    const incoming = Array.isArray(body.dates) ? body.dates.filter(isDate) : [];
    if (!incoming.length) return { error: 'no valid dates' };
    const merged = [...new Set([...doc.dates, ...incoming])].sort();
    if (merged.length > LIMITS.dates) return { error: 'date limit reached' };
    doc.dates = merged;
  },

  removeDate(doc, body) {
    const d = clean(body.date, 10);
    doc.dates = doc.dates.filter((x) => x !== d);
    for (const v of Object.values(doc.votes)) v.picks = v.picks.filter((x) => x !== d);
    if (doc.locked === d) doc.locked = null;
  },

  post(doc, body) {
    const name = clean(body.name, LIMITS.name);
    const text = clean(body.text, LIMITS.text);
    if (!name || !text) return { error: 'name and text required' };
    const team = findTeam(doc, body.teamId);
    doc.messages.push({ id: newId(), name, teamId: team ? team.id : null, text, ts: Date.now() });
    if (doc.messages.length > LIMITS.messages) {
      doc.messages = doc.messages.slice(-LIMITS.messages);
    }
  },

  /* ------------------------------------------------------------- teams */

  addTeam(doc, body) {
    const name = clean(body.name, LIMITS.teamName);
    if (!name) return { error: 'team name required' };
    if (doc.teams.length >= LIMITS.teams) return { error: 'team limit reached' };
    if (doc.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      return { error: 'a team with that name already exists' };
    }
    doc.teams.push({
      id: newId(),
      name,
      emoji: clean(body.emoji, LIMITS.emoji) || '🏈',
      color: clean(body.color, 12) || '',
      managers: cleanManagers(body.managers),
      created: Date.now(),
    });
  },

  updateTeam(doc, body) {
    const team = findTeam(doc, body.teamId);
    if (!team) return { error: 'team not found' };
    const name = clean(body.name, LIMITS.teamName);
    if (name) {
      const dup = doc.teams.some((t) => t.id !== team.id && t.name.toLowerCase() === name.toLowerCase());
      if (dup) return { error: 'a team with that name already exists' };
      team.name = name;
    }
    if (body.emoji !== undefined) team.emoji = clean(body.emoji, LIMITS.emoji) || '🏈';
    if (body.color !== undefined) team.color = clean(body.color, 12);
    if (body.managers !== undefined) team.managers = cleanManagers(body.managers);
  },

  removeTeam(doc, body) {
    const team = findTeam(doc, body.teamId);
    if (!team) return { error: 'team not found' };
    doc.teams = doc.teams.filter((t) => t.id !== team.id);
    // Drop the reference everywhere rather than leaving dangling ids behind.
    Object.values(doc.votes).forEach((v) => { if (v.teamId === team.id) v.teamId = null; });
    doc.messages.forEach((m) => { if (m.teamId === team.id) m.teamId = null; });
    doc.awards = doc.awards.filter((a) => a.teamId !== team.id);
    if (doc.order) doc.order.list = doc.order.list.filter((id) => id !== team.id);
    if (doc.power) doc.power.list = doc.power.list.filter((p) => p.teamId !== team.id);
  },

  /** Add one co-manager without needing to resend the whole roster. */
  /** Add a co-manager, or update the role of one who is already listed. */
  joinTeam(doc, body) {
    const team = findTeam(doc, body.teamId);
    if (!team) return { error: 'team not found' };
    const manager = clean(body.manager, LIMITS.name);
    if (!manager) return { error: 'manager name required' };
    const role = clean(body.role, LIMITS.role) || 'Manager';

    const existing = findManager(team, manager);
    if (existing) { existing.role = role; return; }
    if (team.managers.length >= LIMITS.managers) return { error: 'manager limit reached' };
    team.managers.push({ name: manager, role });
  },

  setRole(doc, body) {
    const team = findTeam(doc, body.teamId);
    if (!team) return { error: 'team not found' };
    const m = findManager(team, body.manager);
    if (!m) return { error: 'manager not found' };
    m.role = clean(body.role, LIMITS.role) || 'Manager';
  },

  leaveTeam(doc, body) {
    const team = findTeam(doc, body.teamId);
    if (!team) return { error: 'team not found' };
    const n = clean(body.manager, LIMITS.name).toLowerCase();
    team.managers = team.managers.filter((m) => m.name.toLowerCase() !== n);
  },

  /* ---------------------------------------------------- draft order */

  /**
   * Shuffle here rather than in the browser so every manager loads the same
   * order — a client-side draw would give each viewer a different answer and
   * invite exactly the "it was rigged" argument the lottery is meant to settle.
   */
  drawOrder(doc) {
    if (doc.teams.length < 2) return { error: 'add at least two teams first' };
    const ids = doc.teams.map((t) => t.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    doc.order = { list: ids, ts: Date.now() };
  },

  clearOrder(doc) { doc.order = null; },

  /* --------------------------------------------------------- rules */

  setRules(doc, body) {
    const r = body.rules || {};
    doc.rules = {
      scoring: clean(r.scoring, LIMITS.rules),
      dues: clean(r.dues, 200),
      payouts: clean(r.payouts, LIMITS.rules),
      punishment: clean(r.punishment, LIMITS.rules),
      notes: clean(r.notes, LIMITS.rules),
    };
  },

  /* -------------------------------------------- awards + power rankings */

  addAward(doc, body) {
    const title = clean(body.title, 60);
    if (!title) return { error: 'award title required' };
    const team = findTeam(doc, body.teamId);
    if (!team) return { error: 'pick a team' };
    const week = Math.max(1, Math.min(18, parseInt(body.week, 10) || 1));
    doc.awards.push({
      id: newId(), week, title, teamId: team.id,
      note: clean(body.note, 240), ts: Date.now(),
    });
    if (doc.awards.length > LIMITS.awards) doc.awards = doc.awards.slice(-LIMITS.awards);
  },

  removeAward(doc, body) {
    const id = clean(body.awardId, 40);
    doc.awards = doc.awards.filter((a) => a.id !== id);
  },

  setPower(doc, body) {
    const list = (Array.isArray(body.list) ? body.list : [])
      .map((p) => ({ teamId: clean(p.teamId, 40), note: clean(p.note, 240) }))
      .filter((p) => findTeam(doc, p.teamId))
      .slice(0, LIMITS.teams);
    if (!list.length) return { error: 'no teams ranked' };
    doc.power = { list, ts: Date.now(), author: clean(body.author, LIMITS.name) };
  },

  lock(doc, body) {
    if (body.date === null) { doc.locked = null; return; }
    const d = clean(body.date, 10);
    if (!isDate(d) || !doc.dates.includes(d)) return { error: 'invalid date' };
    doc.locked = d;
  },

  rename(doc, body) {
    const n = clean(body.name, LIMITS.leagueName);
    if (n) doc.name = n;
  },
};

/* --------------------------------------------------------------- handler */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const meta = { driver: DRIVER, ephemeral: DRIVER === 'memory' };

  try {
    if (req.method === 'GET') {
      const id = clean((req.query && req.query.id) || '', 40);
      if (!id) return res.status(200).json({ ok: true, meta });
      const league = await loadLeague(id);
      if (!league) return res.status(404).json({ ok: false, error: 'not_found', meta });
      return res.status(200).json({ ok: true, league, meta });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'method_not_allowed', meta });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    if (body.action === 'create') {
      const doc = doCreate(body);
      await writeRaw(docKey(doc.id), JSON.stringify(doc));
      return res.status(200).json({ ok: true, league: doc, meta });
    }

    const id = clean(body.id, 40);
    if (!id) return res.status(400).json({ ok: false, error: 'id required', meta });

    const fn = ACTIONS[body.action];
    if (!fn) return res.status(400).json({ ok: false, error: 'unknown action', meta });

    const out = await mutate(id, (doc) => fn(doc, body));
    if (out.error) {
      const code = out.error === 'not_found' ? 404 : out.error === 'conflict' ? 409 : 400;
      return res.status(code).json({ ok: false, error: out.error, meta });
    }
    return res.status(200).json({ ok: true, league: out.league, meta });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err), meta });
  }
};
