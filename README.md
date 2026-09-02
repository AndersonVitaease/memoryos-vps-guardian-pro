# MemoryOS VPS Guardian Pro (PRIVATE)

**Proprietary / commercial — NOT open source.** See `LICENSE-COMMERCIAL.txt`.

Private local foundation that reuses the free, open-source public server
(`memoryos-vps-guardian`, Apache-2.0, pinned at `v0.1.0`) and adds the
**private Supertools**: `engineering.vps.doctor`, `engineering.vps.change.safe`
and `engineering.vps.reconcile`.

- Free: the 10 public Simple Tools live in the public repository only.
- Paid: Supertools live ONLY in this private repository.
- The public repository never contains, references or depends on this code.

## Composition

`createProContext()` builds the operator-controlled evidence adapters ONCE;
the SAME instances are passed to the public `buildServer()` and to the
private doctor registration (single shared-adapter composition, no MCP
tool-to-tool recursion, no new evidence source, no state).

Pro catalog: exactly 13 tools = 10 public Simple Tools + `engineering.vps.doctor`
+ `engineering.vps.change.safe` (PLAN + governed EXECUTE of `application.redeploy`
against an operator-configured target allowlist via
`MEMORYOS_VPS_GUARDIAN_CHANGE_TARGETS`; PLAN_READY is never approval, never a
safety guarantee and never execution) + `engineering.vps.reconcile` (read-only
drift detection).

## engineering.vps.change.safe

Two modes over one strict input
`{ action: 'application.redeploy', target: string, execute?: boolean, approval?: { approved: boolean, proposalFingerprint: string } }`
(unknown fields are rejected; the agent never supplies an applicationId,
credential, backend URL, host, IP, command, shell, SSH or tool selection).

- **PLAN** (default): `{ action, target }` resolves the logical target ONLY
  against the operator allowlist, collects existing read-only evidence, runs
  deterministic prechecks and returns `PLAN_READY | BLOCKED | UNKNOWN` with
  fixed risk `REQUIRES_APPROVAL` and a deterministic SHA-256
  `proposalFingerprint` (output only; it authorizes nothing).
- **EXECUTE** (`execute: true`): requires
  `approval: { approved: true, proposalFingerprint }`. Before ANY mutation the
  tool re-resolves the target, re-collects fresh evidence, re-runs the same
  prechecks, recomputes the fingerprint and compares it with
  `approval.proposalFingerprint` (TOCTOU binding): a mismatch returns
  `SNAPSHOT_CHANGED` and absent/not-granted approval returns
  `APPROVAL_REQUIRED` — both with ZERO mutation. Only then does it perform
  exactly ONE mutation attempt through the operator-configured
  `SafeChangeAdapter` (single capability `application-redeploy`; no retry, no
  auto-recovery, no polling), followed by mandatory read-only post-validation
  reported as `VERIFIED | FAILED | PENDING | UNKNOWN_REQUIRES_HUMAN_REVIEW`.
  Backend acceptance is NEVER treated as success. Rollback is not available:
  `rollback.available=false` and `rollback.performed=false` always.

Authority stays with the operator configuration: approval binds a plan, it
does not create authority. `proposalFingerprint` is a local correlation/action
key; backend idempotency is not claimed.

### Operator configuration (construction time; never agent input)

| Variable | Meaning |
| --- | --- |
| `MEMORYOS_VPS_GUARDIAN_CHANGE_TARGETS` | JSON allowlist `{ logicalKey: { applicationId, applicationName } }`; missing/empty = no target may ever be planned |
| `MEMORYOS_VPS_GUARDIAN_CHANGE_BACKEND_URL` | Change backend endpoint for the `SafeChangeAdapter` (agentMemoryBridge) |
| `MEMORYOS_VPS_GUARDIAN_CHANGE_CREDENTIAL` | Change backend credential (sent as `x-agent-memory-token`; never logged, never output) |
| `MEMORYOS_VPS_GUARDIAN_CHANGE_SERVER_ID` | Optional backend serverId (fixed default) |

URL and credential must be configured together or both absent; absent means
NO mutation capability exists and every EXECUTE fails closed with zero
mutation. Network/mutation authority lives ONLY inside
`src/change/safeChangeAdapter.ts`; the transport is injectable and tests use
deterministic fakes (no real VPS/Dokploy).

## engineering.vps.reconcile

READ-ONLY drift detection Supertool (ported from the certified ENG-MCP
implementation; input is exactly `{}`).

- **EXPECTED state**: exclusively the operator-configured release-state file
  (`MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE`, the same operator surface used
  for deployment evidence; read raw, never written). Absent/unreadable means
  the expected side is simply unavailable.
- **ACTUAL state**: this server's own tool catalog (SHA-256 over the sorted
  registered tool names, catalog version `pro-tools-v0.1.0`, actual tool
  count); container inspection is not injected in this MVP and stays
  unavailable.
- **Verdict**: `DRIFTED` (any determined mismatch), `IN_SYNC` (determined
  matches, none mismatched) or `UNKNOWN` (zero determined comparisons).
  **Absence of evidence is NEVER drift** — undeterminable comparisons return
  `UNKNOWN` with info findings, never a mismatch.
- **Zero mutation**: no execute/approval input exists;
  `mutationPerformed: false` is structural. No LLM, no SSH/shell, no Dokploy
  changes, never writes the release-state file.

## Commands

```
npm install
npm run typecheck
npm test
npm start        # MCP stdio server (Pro)
```

No API, no database, no dashboard, no billing, no login, no remote MCP, no
entitlement/licensing logic in this stage. The registration points of the
Supertools (`src/doctor/registerDoctor.ts`, `src/change/registerChangeSafe.ts`,
`src/reconcile/registerReconcile.ts`) are the single future gate; change.safe
executes only the single allowlisted action through the single
operator-configured adapter.
