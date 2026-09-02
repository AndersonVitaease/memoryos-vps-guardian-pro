# MemoryOS VPS Guardian Pro (PRIVATE)

**Proprietary / commercial — NOT open source.** See `LICENSE-COMMERCIAL.txt`.

Private local foundation that reuses the free, open-source public server
(`memoryos-vps-guardian`, Apache-2.0, pinned at `v0.1.0`) and adds the first
**private Supertools**: `engineering.vps.doctor` and `engineering.vps.change.safe` (PLAN_ONLY).

- Free: the 10 public Simple Tools live in the public repository only.
- Paid: Supertools live ONLY in this private repository.
- The public repository never contains, references or depends on this code.

## Composition

`createProContext()` builds the operator-controlled evidence adapters ONCE;
the SAME instances are passed to the public `buildServer()` and to the
private doctor registration (single shared-adapter composition, no MCP
tool-to-tool recursion, no new evidence source, no state).

Pro catalog: exactly 12 tools = 10 public Simple Tools + `engineering.vps.doctor`
+ `engineering.vps.change.safe` (STRICTLY PLAN_ONLY: plans `application.redeploy`
against an operator-configured target allowlist via
`MEMORYOS_VPS_GUARDIAN_CHANGE_TARGETS` and NEVER executes; no mutation
primitive, no approval input and no execution exist in this stage; PLAN_READY
is never approval, never a safety guarantee and never execution).

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
are the single future gate; change.safe remains fail-closed PLAN_ONLY (no
execute, no approval, no mutation adapter, no credential surface).
