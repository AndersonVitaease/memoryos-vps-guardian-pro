# MemoryOS VPS Guardian Pro (PRIVATE)

**Proprietary / commercial — NOT open source.** See `LICENSE-COMMERCIAL.txt`.

Private local foundation that reuses the free, open-source public server
(`memoryos-vps-guardian`, Apache-2.0, pinned at `v0.1.0`) and adds the first
**private Supertool**: `engineering.vps.doctor`.

- Free: the 10 public Simple Tools live in the public repository only.
- Paid: Supertools live ONLY in this private repository.
- The public repository never contains, references or depends on this code.

## Composition

`createProContext()` builds the operator-controlled evidence adapters ONCE;
the SAME instances are passed to the public `buildServer()` and to the
private doctor registration (single shared-adapter composition, no MCP
tool-to-tool recursion, no new evidence source, no state).

Pro catalog: exactly 11 tools = 10 public Simple Tools + `engineering.vps.doctor`.

## Commands

```
npm install
npm run typecheck
npm test
npm start        # MCP stdio server (Pro)
```

No API, no database, no dashboard, no billing, no login, no remote MCP, no
entitlement/licensing logic in this stage. The registration point of the
Supertool (`src/doctor/registerDoctor.ts`) is the single future gate.
