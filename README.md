# VPS Guardian

Give AI agents VPS deployment capabilities without giving them unrestricted infrastructure authority.

VPS Guardian is a safe execution layer for AI-agent VPS operations: bounded authority, state-bound execution and evidence-based outcomes — built as a domain proof for [Guardian Core v0.1.0](https://github.com/AndersonVitaease/memoryos-guardian-core).

## The problem

An AI agent may need to redeploy one application.

That does not mean it should receive unrestricted shell, SSH, Docker or VPS authority. Unrestricted infrastructure authority creates a much larger authority surface than the task requires — and it fails in familiar ways:

- the **wrong target** is deployed to (the agent picks a plausible name, not the authorized one);
- the **state changed** between the agent's decision and its execution (stale decision over new state);
- a **deployment is already in progress** for the same application;
- the backend **accepts the request but the deployment never verifies** — acceptance is not success;
- a **retry** after an ambiguous outcome dispatches a second mutation nobody can account for;
- **two concurrent decisions** for the same target both pass validation and both dispatch.

VPS Guardian explores a narrower model:

```
intent → eligibility → state observation → approval/state binding
      → controlled execution → independent post-validation
      → evidence-based result
```

## What VPS Guardian does

One governed operation — `application.redeploy` — behind one strict input schema:

```
Intent
  ↓  authorized target resolution (operator allowlist only — the agent never supplies an applicationId, credential, URL, host or shell)
  ↓  deterministic prechecks on fresh read-only evidence
  ↓  proposal / evidence snapshot
  ↓  SHA-256 proposal fingerprint
  ↓  approval bound to that fingerprint
  ↓  fresh revalidation: re-resolve, re-collect, re-check, recompute fingerprint (mismatch → SNAPSHOT_CHANGED, zero mutation)
  ↓  controlled mutation: exactly ONE attempt, no unsafe automatic retry
  ↓  fresh post-validation (independent observation)
  ↓  VERIFIED / FAILED / PENDING / UNKNOWN_REQUIRES_HUMAN_REVIEW
```

- **acceptance ≠ success**: backend acceptance is never treated as a successful deployment.
- **VERIFIED requires postcondition evidence** from a fresh observation.
- **UNKNOWN stays UNKNOWN** when evidence is insufficient — never guessed, never retried automatically.

## Why not just give the agent SSH?

SSH/shell grants a broad, general-purpose execution surface. For agentic automation of *specific* operations, exposing narrow governed operations instead of machine authority can be preferable: the agent can do the task but cannot do everything else. SSH is not always wrong — unrestricted authority for narrow tasks is a trade worth questioning.

## Safety properties demonstrated

- operator-controlled target allowlist (missing/empty = no target may ever be planned);
- fail-closed eligibility (absent approval, absent backend capability → zero mutation);
- proposal fingerprint bound to observed evidence; stale decision refusal (`SNAPSHOT_CHANGED`, zero mutation);
- fresh revalidation before any mutation (TOCTOU binding);
- one mutation attempt, no unsafe automatic retry, no auto-recovery;
- independent post-validation; VERIFIED only from evidence; explicit UNKNOWN/indeterminacy;
- same-instance (same process) concurrent redeploy protection for the same resolved applicationId (GC-08C).

**Same-instance only** — see [Concurrency](#concurrency).

## Concurrency

Initial red-team testing proved that fingerprint/state revalidation protects stale decisions but did **NOT** protect two simultaneously compatible decisions. GC-08B reproduced duplicate mutation dispatch for overlapping executions against the same target. GC-08C added a keyed in-memory reservation by resolved `applicationId` (synchronous check+add, mandatory release in `finally`).

Current guarantee: **same process + same resolved applicationId + overlapping executions → at most one crosses the redeploy dispatch boundary.** The loser is refused before the mutation boundary with zero mutation (`NOT_EXECUTED`-equivalent). Different applicationIds never block each other.

Current non-guarantees (explicitly): no cross-process serialization, no cross-machine serialization, no distributed lock, no exactly-once execution, no backend-native idempotency.

## Example behavior

Agent asks: *"Redeploy Gateway"*

1. Guardian resolves `Gateway → app-1` — only if the operator allowlist contains it.
2. Before any mutation it asks: current state safe? Is the approval valid for this exact snapshot? Is state still compatible? Is another same-instance redeploy for `app-1` already executing?
3. Only then may the single controlled redeploy execute.
4. Afterward: "backend accepted the request" ≠ "deployment verified" — a fresh observation is required for `VERIFIED`.

## Architecture relationship

- **VPS Guardian** = domain implementation / proof (Dokploy-style VPS operations).
- **[Guardian Core](https://github.com/AndersonVitaease/memoryos-guardian-core)** = domain-agnostic execution contract (`intent → bind → apply → evidence-based result`), released as **v0.1.0**.

Guardian Core is experimental; this domain proof is how its contract was validated for VPS operations.

## Evidence

- **179/179 tests passing** (165 baseline + 14 added for the GC-08C concurrency hardening).
- **GC-08B**: adversarial red-team reproduction of the simultaneous same-target collision (duplicate dispatch).
- **GC-08C**: same-instance/same-`applicationId` concurrency protection added and regression-tested (deterministic, timer-free concurrency tests).
- Stale-decision protection (`SNAPSHOT_CHANGED`) demonstrated by scripted bind/apply drift tests.

Tested and demonstrated — not formally proven.

## Known limitations

- experimental; not production-certified;
- same-instance concurrency protection only — no cross-process or cross-machine lock;
- no exactly-once; no backend idempotency claim;
- backend-specific (Dokploy) semantics not fully characterized by real concurrent production testing;
- `NO_DEPLOYMENT_IN_FLIGHT` depends on visible backend evidence;
- adapter/domain trust assumptions; no malicious-adapter guarantee (inherited from Guardian Core where relevant).

## Status

Experimental / research implementation. Guardian Core: v0.1.0. VPS Guardian: current proof implementation (no separate semantic version claimed).

## Commands

```
npm install
npm run typecheck
npm test
npm start        # MCP stdio server
```

## Guardian ecosystem

- [Guardian Core](https://github.com/AndersonVitaease/memoryos-guardian-core) — domain-agnostic Safe Execution Core (bind → gate → apply, fail-closed).
- [GitHub Guardian](https://github.com/AndersonVitaease/memoryos-github-guardian-proof) — state-bound PR merge execution using GitHub's native SHA precondition and independent post-merge verification.
- [Filesystem Guardian](https://github.com/AndersonVitaease/memoryos-filesystem-guardian-proof) — stale-state-safe file changes with bounded filesystem authority and read-back verification.
- [Email Guardian](https://github.com/AndersonVitaease/memoryos-email-guardian-proof) — bounded outbound email execution with stale-state protection, same-instance keyed duplicate suppression and evidence-based outcomes.
