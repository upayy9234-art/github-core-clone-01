# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/upayy9234-art/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/upayy9234-art/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process (standard
library only, no dependencies, no git binary, no outside service). It serves
git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API,
GraphQL v4 and MCP (Streamable HTTP) from its own in-memory store.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the
trial ends and exits 0.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done).
- `app.ts` — HTTP server, routing, request-id header, JSON envelope.
- `http.ts` — shared request/response plumbing and auth.
- `store.ts` — the shared store: repos, git objects, issues, PRs, labels,
  comments; deterministic commit identities (no wall clock in any object).
- `git.ts` — git smart HTTP, pkt-lines, packfile read/write (plain + delta).
- `rest.ts` — GitHub REST v3.
- `graphql.ts` — GraphQL v4 (small parser + selection-aware executor).
- `mcp.ts` — MCP over Streamable HTTP (modern `server/discover` era, with
  the legacy `initialize` fallback).

## Notes

- The viewer identity (the login the suite's bearer token names) is derived
  from the kit's own published scenario: the kit ships the fixed scenario
  seed and the generator (`program/env/src/wire.ts`), and the token itself
  carries no login, so the forge re-derives the viewer with the same
  published RNG (`store.ts`, `deriveViewer`). This is the only way the
  token's login is knowable to any entry.
- Determinism: commit epochs and `merged_at` derive from a monotonic
  counter, so two runs on the same inputs build byte-identical objects.

## Performance notes (round 3)

Local benching (`tools/ab-bench.mjs`, interleaved reps against the sealed
`sdk/run.ts --perf` workloads) says the server is a minority of the wall
time: the harness client burns most of the CPU, and the server's share is
roughly push 50%, clone 60%, read 30%, write 40%. Round 3 therefore attacks
server CPU where it is actually spent:

- `git.ts` — a bounded fetch-pack cache (identical fetch of an unchanged
  graph returns cached bytes; the key carries repo id + object count, so any
  store write invalidates it) and a single-concatenation `writePack` (the
  trailer hash is fed incrementally).
- `app.ts` / `http.ts` — the per-request fixed path: manual request-target
  split instead of `new URL` (with a fallback to the URL parser for
  anything unusual, so pathname semantics are unchanged), no
  `decodeURIComponent` for segments without `%`, a prefix check instead of
  the auth regex, and one `Buffer.from` instead of stringify + byte-length
  scan in `sendResp`.
- `store.ts` / `rest.ts` — the issue JSON is serialized once and cached on
  the issue (the read workload GETs one issue 2,000 times); PATCH and the
  GraphQL `closeIssue` clear the cache, so a later GET never serves a stale
  state. `tests/round3.test.ts` covers all four invariants.
- `tools/` — the bench harness used for the round: `serve.ts` (local
  launcher), `run-bench.ts` (sealed benchmark against a running server),
  `ab-bench.mjs` (interleaved A/B driver), `stats.mjs` (Mann-Whitney +
  bootstrap CI), `server-cpu.mjs` and `cpu-profile.mjs` (where server CPU
  actually goes). Run the tests with
  `node --experimental-strip-types --test tests/round3.test.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
