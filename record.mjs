// Records every change ESPN makes to any player's projection, for every week
// from now to the end of the season, with the time it was seen.
//
// Tim, 2026-10-31: "make sure we are recording every single proj and it's
// change for every player and store them somewhere" / "record the time and
// date for each change, the player, and all future week change's in proj.
// (weeks now-end of season). Don't set up any analysis or anything on it yet".
//
// WHY THIS EXISTS: ESPN keeps no projection history (the Fantasy Football
// site's rule 8). An old number is overwritten and gone, so the only history
// there will ever be is the one recorded while it is showing.
//
// HOW: GitHub Actions runs this every hour. One ESPN read per week (there is no
// bulk form), through the PUBLIC test league 1241838, so no login is needed.
// Projections are ESPN's own and the same in every league; only the points
// depend on the league's scoring, which is why the raw stat lines are kept too
// (state file) — any scoring can be applied to them later.
//
// WHAT IT WRITES:
//   log/<season>/<yyyy-mm-dd>.csv  one row per change (UTC date of the run):
//     time_utc,time_mt,player_id,name,pos,team,week,old,new
//     week = an NFL week, or "ros" for ESPN's rest-of-season total.
//     old empty = first time seen; new empty = projection gone.
//     The time is when the run SAW the change: it happened within the hour before.
//   state/<season>.json  the latest full picture: every player, every week,
//     points AND ESPN's raw projected stats. One player per line, so git keeps
//     every past version cheaply; the git history of this file IS the full
//     stat-level history.
//
// No dependencies. Node 20+.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';

const LEAGUE = 1241838;
const SEASON = Number(process.env.SEASON || 2026);
const LAST_WEEK = 18;
const HOST = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE}`;
const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const TEAMS = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN',
  8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR',
  15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI',
  22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH',
  29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

async function read(view, { week, filter } = {}) {
  const url = `${HOST}?view=${view}${week ? `&scoringPeriodId=${week}` : ''}`;
  const headers = { Accept: 'application/json' };
  if (filter) headers['x-fantasy-filter'] = JSON.stringify(filter);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw new Error(`${view} week ${week}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

/** Every player's projection for one week. A week costs one read. */
async function weekOf(week) {
  // No filterStatus: rostered AND free agents. No stats filter: with one, ESPN
  // drops the weekly line (the site's rule 4).
  const filter = { players: { limit: 3000, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
  const data = await read('kona_player_info', { week, filter });
  const out = new Map();
  for (const e of data.players || []) {
    const p = e.player;
    if (!p) continue;
    const stats = p.stats || [];
    const wk = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === week);
    const ros = stats.find((s) => s.statSourceId === 1 && s.statSplitTypeId === 2 && s.seasonId === SEASON);
    out.set(String(p.id), {
      n: p.fullName, pos: POS[p.defaultPositionId] || String(p.defaultPositionId),
      tm: TEAMS[p.proTeamId] ?? String(p.proTeamId),
      wk: wk ? pack(wk) : null,
      ros: ros ? pack(ros) : null,
    });
  }
  return out;
}

const pack = (s) => {
  const st = {};
  for (const k of Object.keys(s.stats || {}).sort((a, b) => a - b)) {
    const v = s.stats[k];
    if (typeof v === 'number' && v !== 0) st[k] = r4(v);
  }
  return [r2(s.appliedTotal || 0), st];
};

function loadState(path) {
  if (!existsSync(path)) return { players: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** One player per line: git stores each run as a small delta. */
function saveState(path, state) {
  const ids = Object.keys(state.players).sort((a, b) => a - b);
  const lines = ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(state.players[id])}`);
  const head = JSON.stringify({ season: state.season, week: state.week, takenAt: state.takenAt });
  writeFileSync(path, `${head.slice(0, -1)},"players":{\n${lines.join(',\n')}\n}}\n`);
}

const csv = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const status = await read('mStatus');
  const current = Number(status.scoringPeriodId);
  const final = Math.max(LAST_WEEK, Number(status.status?.finalScoringPeriod) || 0);
  if (!current || current > final) { console.log('season over, nothing to record'); return; }

  const weeks = [];
  for (let w = current; w <= final; w++) weeks.push(w);

  const now = new Date();
  const timeUtc = now.toISOString().slice(0, 19) + 'Z';
  const timeMt = now.toLocaleString('sv-SE', { timeZone: 'America/Denver' }).replace(' ', 'T');

  // New picture: id -> { n, pos, tm, w: { week: [pts, stats], ros: [...] } }
  const fresh = {};
  for (const w of weeks) {
    const got = await weekOf(w);
    for (const [id, x] of got) {
      const p = fresh[id] || (fresh[id] = { n: x.n, pos: x.pos, tm: x.tm, w: {} });
      if (x.wk) p.w[w] = x.wk;
      if (x.ros && !p.w.ros) p.w.ros = x.ros;
    }
  }
  // A man with no projection in any week left is not tracked.
  for (const id of Object.keys(fresh)) if (!Object.keys(fresh[id].w).length) delete fresh[id];

  const statePath = `state/${SEASON}.json`;
  mkdirSync('state', { recursive: true });
  const old = loadState(statePath);

  // Points changes, for the log. A week now in the past is simply no longer
  // compared: its projection stopped being a forecast.
  const keys = [...weeks.map(String), 'ros'];
  const rows = [];
  const ids = new Set([...Object.keys(old.players || {}), ...Object.keys(fresh)]);
  for (const id of [...ids].sort((a, b) => a - b)) {
    const a = (old.players || {})[id];
    const b = fresh[id];
    const who = b || a;
    for (const k of keys) {
      const was = a && a.w[k] ? a.w[k][0] : null;
      const is = b && b.w[k] ? b.w[k][0] : null;
      if (was === is) continue;
      rows.push([timeUtc, timeMt, id, who.n, who.pos, who.tm, k, was, is].map(csv).join(','));
    }
  }

  saveState(statePath, { season: SEASON, week: current, takenAt: timeUtc, players: fresh });

  if (rows.length) {
    const dir = `log/${SEASON}`;
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/${timeUtc.slice(0, 10)}.csv`;
    if (!existsSync(file)) writeFileSync(file, 'time_utc,time_mt,player_id,name,pos,team,week,old,new\n');
    appendFileSync(file, rows.join('\n') + '\n');
  }
  console.log(`weeks ${current}-${final}, ${Object.keys(fresh).length} players, ${rows.length} changes`);
}

main().catch((err) => { console.error(err); process.exit(1); });
