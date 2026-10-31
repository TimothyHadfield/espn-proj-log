# ESPN projection log

Every hour, a GitHub Action reads ESPN's fantasy football projections for every player and every week from now to the end of the season, and records each change with the time it was seen. ESPN keeps no history of its own projections, so this is the only record of them.

- `log/<season>/<date>.csv`: one row per change: `time_utc, time_mt, player_id, name, pos, team, week, old, new`. `week` is an NFL week or `ros` (ESPN's rest-of-season total). An empty `old` means first seen; an empty `new` means the projection disappeared. The time is when the hourly run saw the change.
- `state/<season>.json`: the latest full picture, with points and ESPN's raw projected stats per player-week. Its git history holds every earlier version.

Points are scored with public league 1241838's rules. The raw stats allow re-scoring for any league.

Run by hand: `node record.mjs` (Node 20+, no dependencies).
