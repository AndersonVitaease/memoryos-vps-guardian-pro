/**
 * engineering.vps.reconcile — READ-ONLY drift detection Supertool.
 *
 * Ported from the certified ENG-MCP implementation (src/vpsReconcile.ts,
 * SPRINT VPS-RECONCILE-01, READ-ONLY drift detection MVP) preserving the
 * certified semantics EXACTLY:
 *
 * EXPECTED STATE: exclusively the operator-configured release-state file
 * (existing Pro convention MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE, the same
 * operator surface already wired for deployment evidence). No new entity, no
 * database, no manifest, no baseline, no DesiredStateEngine, no framework.
 *
 * ACTUAL STATE: only mechanisms that already exist (this server's own tool
 * catalog, injected by the registration site from the composition's exact
 * tool list; container inspection stays available as an injectable dep and is
 * NOT injected at the registration site, so it defaults to unavailable —
 * exactly like the certified original).
 *
 * Absence of evidence is NEVER drift: any comparison that cannot be
 * determined stays unknown and never produces a mismatch finding. Zero
 * mutation (no execute/approval input exists, mutationPerformed is
 * structurally false); no LLM; no SSH/shell; no Dokploy changes; no VPS
 * changes; never writes the release-state file.
 *
 * Only real incompatibilities were adapted (integration, not semantics): the
 * certified original read release-state.json under ENG_MCP_REPOSITORY_ROOT;
 * the Pro reads the operator-configured release-state file path from its
 * existing environment convention. The comparison logic, finding codes,
 * severity rules and status determination are unchanged.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export type ReconcileStatus = "IN_SYNC" | "DRIFTED" | "UNKNOWN";
export type ReconcileSeverity = "critical" | "warning" | "info";

export interface ReconcileFinding {
  code: string;
  severity: ReconcileSeverity;
  expected?: unknown;
  actual?: unknown;
}

export interface ExpectedStateSnapshot {
  currentRelease?: string;
  productionImageId?: string;
  sourceHash?: string;
  productionCatalogHash?: string;
  toolCount?: number;
  catalogVersion?: string;
  deployStatus?: string;
  smokeStatus?: string;
  rollbackStatus?: string;
}

export interface ActualContainerSnapshot {
  image?: string;
  imageId?: string;
  running?: boolean;
}

export interface ActualCatalogSnapshot {
  catalogHash?: string;
  catalogVersion?: string;
  toolCount?: number;
}

export interface ActualStateSnapshot {
  container: ActualContainerSnapshot | null;
  catalog: ActualCatalogSnapshot | null;
}

export interface VpsReconcileDeps {
  readReleaseState?: () => Promise<unknown>;
  inspectContainer?: () => Promise<ActualContainerSnapshot | null>;
  readCatalog?: () => Promise<ActualCatalogSnapshot | null>;
}

/**
 * Operator-configured release-state file (existing Pro convention, reused —
 * NOT a new operator surface). Read RAW: this Supertool compares the file's
 * own fields and never reinterprets it as application evidence.
 */
export const RECONCILE_RELEASE_STATE_FILE_ENV = "MEMORYOS_VPS_GUARDIAN_RELEASE_STATE_FILE";

/**
 * Deterministic catalog version of this private Pro server. Maintained per
 * Pro release (the certified original carried the equivalent
 * "eng-mcp-tools-vN" identity); it is compared against the expected
 * catalogVersion when the release-state file declares one.
 */
export const PRO_CATALOG_VERSION = "pro-tools-v0.1.0";

/**
 * Deterministic actual-state catalog snapshot over an exact list of
 * registered tool names: SHA-256 over the JSON array of the SORTED names
 * (stable across processes), the declared catalog version and the actual
 * tool count. Pure and deterministic: no I/O, no environment reads.
 */
export function createProCatalogSnapshot(
  toolNames: readonly string[],
  catalogVersion: string = PRO_CATALOG_VERSION,
): ActualCatalogSnapshot {
  const sorted = [...toolNames].sort();
  const catalogHash = createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  return { catalogHash, catalogVersion, toolCount: sorted.length };
}

/**
 * Default expected-state reader (operator-configured file path; both the
 * path and the read failure are never surfaced to the agent): absent env or
 * any read/parse failure yields null = expected state unavailable. This
 * mirrors the certified original's default reader (env-rooted, swallow ->
 * null). Never writes anything.
 */
export async function defaultReadReleaseState(
  read: (name: string) => string | undefined = (name) => process.env[name],
): Promise<unknown> {
  const filePath = read(RECONCILE_RELEASE_STATE_FILE_ENV);
  if (!filePath) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function pickExpected(raw: unknown): ExpectedStateSnapshot {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return {};
  const state = raw as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof state[key] === "string" && (state[key] as string).length > 0 ? (state[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof state[key] === "number" && Number.isFinite(state[key]) ? (state[key] as number) : undefined;
  return {
    currentRelease: str("currentRelease"),
    productionImageId: str("productionImageId") ?? str("imageId"),
    sourceHash: str("sourceHash"),
    productionCatalogHash: str("productionCatalogHash"),
    toolCount: num("toolCount"),
    catalogVersion: str("catalogVersion"),
    deployStatus: str("deployStatus"),
    smokeStatus: str("smokeStatus"),
    rollbackStatus: str("rollbackStatus"),
  };
}

/**
 * Certified READ-ONLY reconcile flow: compare expected vs actually evidenced
 * state, produce findings and one status (DRIFTED > IN_SYNC > UNKNOWN with
 * zero determined comparisons), never mutate. Deps are injectable for
 * deterministic tests; the registration site injects ONLY the live catalog.
 */
export async function runVpsReconcile(deps: VpsReconcileDeps = {}): Promise<{
  status: ReconcileStatus;
  expected: ExpectedStateSnapshot;
  actual: ActualStateSnapshot;
  findings: ReconcileFinding[];
  mutationPerformed: false;
}> {
  const readReleaseState = deps.readReleaseState ?? defaultReadReleaseState;
  const inspectContainer = deps.inspectContainer ?? (async () => null);
  const readCatalog = deps.readCatalog ?? (async () => null);

  const findings: ReconcileFinding[] = [];
  const push = (code: string, severity: ReconcileSeverity, expected?: unknown, actual?: unknown): void => {
    findings.push({ code, severity, expected, actual });
  };

  let rawExpected: unknown = null;
  try {
    rawExpected = await readReleaseState();
  } catch {
    rawExpected = null;
  }
  const expected = pickExpected(rawExpected);
  if (rawExpected === null || rawExpected === undefined) {
    push("EXPECTED_STATE_INCOMPLETE", "info", undefined, "release-state.json unavailable");
  } else if (
    expected.currentRelease === undefined &&
    expected.productionImageId === undefined &&
    expected.productionCatalogHash === undefined &&
    expected.toolCount === undefined &&
    expected.catalogVersion === undefined
  ) {
    push("EXPECTED_STATE_INCOMPLETE", "info", undefined, "no comparable release-state fields");
  }

  let container: ActualContainerSnapshot | null = null;
  let catalog: ActualCatalogSnapshot | null = null;
  try {
    container = await inspectContainer();
  } catch {
    container = null;
  }
  try {
    catalog = await readCatalog();
  } catch {
    catalog = null;
  }
  if (container === null && catalog === null) push("ACTUAL_STATE_UNAVAILABLE", "info");

  let matched = 0;
  let mismatched = 0;

  if (container !== null && container.running === false) {
    push("CONTAINER_NOT_RUNNING", "critical", true, false);
    mismatched += 1;
  }
  if (container !== null && typeof container.image === "string" && expected.currentRelease !== undefined) {
    if (container.image === expected.currentRelease) matched += 1;
    else {
      push("IMAGE_MISMATCH", "critical", expected.currentRelease, container.image);
      mismatched += 1;
    }
  }
  if (container !== null && typeof container.imageId === "string" && expected.productionImageId !== undefined) {
    if (container.imageId === expected.productionImageId) matched += 1;
    else {
      push("IMAGE_ID_MISMATCH", "critical", expected.productionImageId, container.imageId);
      mismatched += 1;
    }
  }
  if (catalog !== null && typeof catalog.catalogHash === "string" && expected.productionCatalogHash !== undefined) {
    if (catalog.catalogHash === expected.productionCatalogHash) matched += 1;
    else {
      push("CATALOG_HASH_MISMATCH", "critical", expected.productionCatalogHash, catalog.catalogHash);
      mismatched += 1;
    }
  }
  if (catalog !== null && typeof catalog.catalogVersion === "string" && expected.catalogVersion !== undefined) {
    if (catalog.catalogVersion === expected.catalogVersion) matched += 1;
    else {
      push("CATALOG_VERSION_MISMATCH", "critical", expected.catalogVersion, catalog.catalogVersion);
      mismatched += 1;
    }
  }
  if (catalog !== null && typeof catalog.toolCount === "number" && typeof expected.toolCount === "number") {
    if (catalog.toolCount === expected.toolCount) matched += 1;
    else {
      push("TOOL_COUNT_MISMATCH", "critical", expected.toolCount, catalog.toolCount);
      mismatched += 1;
    }
  }

  if (expected.deployStatus === "IN_PROGRESS") push("DEPLOY_IN_PROGRESS", "warning", expected.deployStatus);
  if (expected.deployStatus === "FAIL") push("DEPLOY_FAILED", "warning", expected.deployStatus);
  if (expected.rollbackStatus === "PASS") push("ROLLBACK_DETECTED", "info", expected.rollbackStatus);

  const determined = matched + mismatched;
  let status: ReconcileStatus;
  if (mismatched > 0) status = "DRIFTED";
  else if (determined === 0) status = "UNKNOWN";
  else status = "IN_SYNC";

  return { status, expected, actual: { container, catalog }, findings, mutationPerformed: false };
}

/** Strict tool input: the certified reconcile accepts EXACTLY no input. */
export const vpsReconcileInputSchema = z.object({}).strict();

const expectedStateSnapshotSchema = z
  .object({
    currentRelease: z.string().optional(),
    productionImageId: z.string().optional(),
    sourceHash: z.string().optional(),
    productionCatalogHash: z.string().optional(),
    toolCount: z.number().optional(),
    catalogVersion: z.string().optional(),
    deployStatus: z.string().optional(),
    smokeStatus: z.string().optional(),
    rollbackStatus: z.string().optional(),
  })
  .strict();

/** Strict output schema for the certified result shape. */
export const vpsReconcileOutputSchema = z
  .object({
    status: z.enum(["IN_SYNC", "DRIFTED", "UNKNOWN"]),
    expected: expectedStateSnapshotSchema,
    actual: z
      .object({
        container: z
          .object({
            image: z.string().optional(),
            imageId: z.string().optional(),
            running: z.boolean().optional(),
          })
          .strict()
          .nullable(),
        catalog: z
          .object({
            catalogHash: z.string().optional(),
            catalogVersion: z.string().optional(),
            toolCount: z.number().optional(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    findings: z.array(
      z
        .object({
          code: z.string(),
          severity: z.enum(["critical", "warning", "info"]),
          expected: z.unknown().optional(),
          actual: z.unknown().optional(),
        })
        .strict(),
    ),
    mutationPerformed: z.literal(false),
  })
  .strict();
