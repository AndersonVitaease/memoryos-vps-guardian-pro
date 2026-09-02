# MemoryOS VPS Guardian Pro (PRIVATE)

**Proprietary / commercial — NOT open source.** See `LICENSE-COMMERCIAL.txt`.

Private local foundation that reuses the free, open-source public server
(`memoryos-vps-guardian`, Apache-2.0, pinned at `v0.1.0`) and adds the first
**private Supertools**: `engineering.vps.doctor` and `engineering.vps.change.safe`.

- Free: the 10 public Simple Tools live in the public repository only.
- Paid: Supertools live ONLY in this private repository.
- The public repository never contains, references or depends on this code.

## Composition

`createProContext()` builds the operator-controlled evidence adapters ONCE;
the SAME instances are passed to the public `buildServer()` and to the
private doctor registration (single shared-adapter composition, no MCP
tool-to-tool recursion, no new evidence source, no state).

Pro catalog: exactly 12 tools = 10 public Simple Tools + `engineering.vps.doctor`
+ `engineering.vps.change.safe` (PLAN + governed EXECUTE of `application.redeploy`
against an operator-configured target allowlist via
`MEMORYOS_VPS_GUARDIAN_CHANGE_TARGETS`; PLAN_READY is never approval, never a
safety guarantee and never execution).

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

## Commands

```
npm install
npm run typecheck
npm test
npm start        # MCP stdio server (Pro)
```

No API, no database, no dashboard, no billing, no login, no remote MCP, no
entitlement/licensing logic in this stage. The registration points of the
Supertools (`src/doctor/registerDoctor.ts`, `src/change/registerChangeSafe.ts`)
are the single future gate; change.safe executes only the single allowlisted
action through the single operator-configured adapter.
