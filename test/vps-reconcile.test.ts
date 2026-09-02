/**
 * engineering.vps.reconcile — certification suite.
 *
 * Ported from the certified ENG-MCP test/vps-reconcile.test.ts (SPRINT
 * VPS-RECONCILE-01) and adapted to the Pro (vitest, operator-configured
 * release-state file env, Pro catalog snapshot). All tests use FAKE deps and
 * deterministic fixtures: no filesystem (except the explicitly tested default
 * reader), no env dependence, no network, no LLM, no SSH/shell, no Dokploy
 * calls, zero mutation. Core invariant under test: absence of evidence is
 * NEVER drift (undeterminable comparisons stay UNKNOWN and never produce a
 * mismatch finding), and mutation is structurally impossible.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRO_CATALOG_VERSION,
  RECONCILE_RELEASE_STATE_FILE_ENV,
  createProCatalogSnapshot,
  defaultReadReleaseState,
  runVpsReconcile,
  vpsReconcileInputSchema,
  vpsReconcileOutputSchema,
} from "../src/reconcile/vpsReconcile";
import type { VpsReconcileDeps } from "../src/reconcile/vpsReconcile";

const CURRENT_RELEASE = "pro-candidate:candidate-20260902142724456-935f05adf412";
const PROD_IMAGE_ID = "sha256:8e361c2d-fake";
const PROD_CATALOG_HASH = "85049df64a70e0a69009d1ee03306498f52dc24f1ffe2eafc524bb7985c14ca0";
const PROD_CATALOG_VERSION = "pro-tools-v0.1.0";
const PROD_TOOL_COUNT = 13;

const expectedState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  currentRelease: CURRENT_RELEASE,
  productionImageId: PROD_IMAGE_ID,
  sourceHash: "935f05ad-fake",
  productionCatalogHash: PROD_CATALOG_HASH,
  toolCount: PROD_TOOL_COUNT,
  catalogVersion: PROD_CATALOG_VERSION,
  deployStatus: "PASS",
  smokeStatus: "PASS",
  rollbackStatus: "PASS",
  ...over,
});

const catalog = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  catalogHash: PROD_CATALOG_HASH,
  catalogVersion: PROD_CATALOG_VERSION,
  toolCount: PROD_TOOL_COUNT,
  ...over,
});

const container = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  image: CURRENT_RELEASE,
  imageId: PROD_IMAGE_ID,
  running: true,
  ...over,
});

const run = async (over: VpsReconcileDeps = {}) =>
  runVpsReconcile({
    readReleaseState: over.readReleaseState ?? (async () => expectedState()),
    inspectContainer:
      over.inspectContainer ?? (async () => container() as never as Awaited<ReturnType<NonNullable<VpsReconcileDeps["inspectContainer"]>>>),
    readCatalog: over.readCatalog ?? (async () => catalog() as never as Awaited<ReturnType<NonNullable<VpsReconcileDeps["readCatalog"]>>>),
  });

const findingsOf = (result: Awaited<ReturnType<typeof run>>) => result.findings;
const hasFinding = (result: Awaited<ReturnType<typeof run>>, code: string) =>
  findingsOf(result).some((f) => f.code === code);

// ---- ported certified behaviors (original tests 01-19) ----

describe("engineering.vps.reconcile (ported certified behaviors)", () => {
  it("01 full agreement between expected and actual -> IN_SYNC, zero critical findings", async () => {
    const result = await run();
    expect(result.status).toBe("IN_SYNC");
    expect(findingsOf(result).map((f) => f.code)).toEqual(["ROLLBACK_DETECTED"]);
    expect(result.mutationPerformed).toBe(false);
    expect(result.expected.currentRelease).toBe(CURRENT_RELEASE);
    expect(result.expected.productionCatalogHash).toBe(PROD_CATALOG_HASH);
    expect(result.expected.toolCount).toBe(PROD_TOOL_COUNT);
    expect(result.actual.catalog).toEqual(catalog());
    expect(result.actual.container).toEqual(container());
  });

  it("02 image mismatch -> DRIFTED + IMAGE_MISMATCH (critical) with expected/actual evidence", async () => {
    const result = await run({ inspectContainer: async () => container({ image: "pro-candidate:candidate-OTHER" }) as never });
    expect(result.status).toBe("DRIFTED");
    expect(hasFinding(result, "IMAGE_MISMATCH")).toBe(true);
    const finding = findingsOf(result).find((f) => f.code === "IMAGE_MISMATCH")!;
    expect(finding.severity).toBe("critical");
    expect(finding.expected).toBe(CURRENT_RELEASE);
    expect(finding.actual).toBe("pro-candidate:candidate-OTHER");
    expect(result.mutationPerformed).toBe(false);
  });

  it("03 imageId mismatch -> DRIFTED + IMAGE_ID_MISMATCH", async () => {
    const result = await run({ inspectContainer: async () => container({ imageId: "sha256:stale-fake" }) as never });
    expect(result.status).toBe("DRIFTED");
    expect(hasFinding(result, "IMAGE_ID_MISMATCH")).toBe(true);
  });

  it("04 catalog hash mismatch -> DRIFTED + CATALOG_HASH_MISMATCH", async () => {
    const result = await run({ readCatalog: async () => catalog({ catalogHash: "deadbeef-fake" }) as never });
    expect(result.status).toBe("DRIFTED");
    const finding = findingsOf(result).find((f) => f.code === "CATALOG_HASH_MISMATCH")!;
    expect(finding.severity).toBe("critical");
    expect(finding.expected).toBe(PROD_CATALOG_HASH);
    expect(finding.actual).toBe("deadbeef-fake");
  });

  it("05 catalog version mismatch -> DRIFTED + CATALOG_VERSION_MISMATCH", async () => {
    const result = await run({ readCatalog: async () => catalog({ catalogVersion: "pro-tools-v0.2.0" }) as never });
    expect(result.status).toBe("DRIFTED");
    expect(hasFinding(result, "CATALOG_VERSION_MISMATCH")).toBe(true);
  });

  it("06 toolCount mismatch -> DRIFTED + TOOL_COUNT_MISMATCH", async () => {
    const result = await run({ readCatalog: async () => catalog({ toolCount: 14 }) as never });
    expect(result.status).toBe("DRIFTED");
    const finding = findingsOf(result).find((f) => f.code === "TOOL_COUNT_MISMATCH")!;
    expect(finding.expected).toBe(PROD_TOOL_COUNT);
    expect(finding.actual).toBe(14);
  });

  it("07 container not running -> DRIFTED + CONTAINER_NOT_RUNNING (critical)", async () => {
    const result = await run({ inspectContainer: async () => container({ running: false }) as never });
    expect(result.status).toBe("DRIFTED");
    const finding = findingsOf(result).find((f) => f.code === "CONTAINER_NOT_RUNNING")!;
    expect(finding.severity).toBe("critical");
    expect(finding.expected).toBe(true);
    expect(finding.actual).toBe(false);
  });

  it("08 no expected state AND no actual state -> UNKNOWN, never DRIFTED", async () => {
    const result = await run({
      readReleaseState: async () => null,
      inspectContainer: async () => null,
      readCatalog: async () => null,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(hasFinding(result, "EXPECTED_STATE_INCOMPLETE")).toBe(true);
    expect(hasFinding(result, "ACTUAL_STATE_UNAVAILABLE")).toBe(true);
    expect(findingsOf(result).filter((f) => f.severity === "critical").length).toBe(0);
    expect(result.mutationPerformed).toBe(false);
  });

  it("09 expected present but actual unavailable -> UNKNOWN, never DRIFTED (absence of evidence is not drift)", async () => {
    const result = await run({
      inspectContainer: async () => null,
      readCatalog: async () => null,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(hasFinding(result, "ACTUAL_STATE_UNAVAILABLE")).toBe(true);
    expect(
      findingsOf(result).filter(
        (f) => f.code === "IMAGE_MISMATCH" || f.code === "CATALOG_HASH_MISMATCH" || f.code === "TOOL_COUNT_MISMATCH",
      ).length,
    ).toBe(0);
  });

  it("10 non-object release-state (array) -> EXPECTED_STATE_INCOMPLETE, no throw", async () => {
    const result = await run({ readReleaseState: async () => [1, 2, 3], inspectContainer: async () => null, readCatalog: async () => null });
    expect(result.status).toBe("UNKNOWN");
    expect(hasFinding(result, "EXPECTED_STATE_INCOMPLETE")).toBe(true);
  });

  it("11 readReleaseState rejection is swallowed -> treated as unavailable, no throw", async () => {
    const result = await run({
      readReleaseState: async () => {
        throw new Error("FAKE_FS_FAILURE");
      },
      inspectContainer: async () => null,
      readCatalog: async () => null,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(hasFinding(result, "EXPECTED_STATE_INCOMPLETE")).toBe(true);
  });

  it("12 container evidence absent but catalog matches -> IN_SYNC (one side missing never drifts)", async () => {
    const result = await run({ inspectContainer: async () => null });
    expect(result.status).toBe("IN_SYNC");
    expect(findingsOf(result).filter((f) => f.severity === "critical").length).toBe(0);
    expect(result.actual.container).toBeNull();
    expect(result.actual.catalog).not.toBeNull();
  });

  it("13 inspectContainer rejection is swallowed -> catalog-only comparison still works", async () => {
    const result = await run({
      inspectContainer: async () => {
        throw new Error("FAKE_DOCKER_FAILURE");
      },
    });
    expect(result.status).toBe("IN_SYNC");
    expect(findingsOf(result).filter((f) => f.severity === "critical").length).toBe(0);
  });

  it("14 deployStatus IN_PROGRESS -> warning DEPLOY_IN_PROGRESS, status stays IN_SYNC", async () => {
    const result = await run({ readReleaseState: async () => expectedState({ deployStatus: "IN_PROGRESS" }) });
    expect(result.status).toBe("IN_SYNC");
    const finding = findingsOf(result).find((f) => f.code === "DEPLOY_IN_PROGRESS")!;
    expect(finding.severity).toBe("warning");
  });

  it("15 deployStatus FAIL -> warning DEPLOY_FAILED, status stays IN_SYNC", async () => {
    const result = await run({ readReleaseState: async () => expectedState({ deployStatus: "FAIL" }) });
    expect(result.status).toBe("IN_SYNC");
    expect(hasFinding(result, "DEPLOY_FAILED")).toBe(true);
  });

  it("16 rollbackStatus PASS -> info ROLLBACK_DETECTED", async () => {
    const result = await run();
    expect(hasFinding(result, "ROLLBACK_DETECTED")).toBe(true);
    const finding = findingsOf(result).find((f) => f.code === "ROLLBACK_DETECTED")!;
    expect(finding.severity).toBe("info");
  });

  it("17 productionImageId falls back to legacy imageId key -> comparison still determined", async () => {
    const result = await run({
      readReleaseState: async () => ({ imageId: PROD_IMAGE_ID }),
      inspectContainer: async () => ({ imageId: PROD_IMAGE_ID }) as never,
      readCatalog: async () => null,
    });
    expect(result.status).toBe("IN_SYNC");
    expect(result.expected.productionImageId).toBe(PROD_IMAGE_ID);
    expect(hasFinding(result, "EXPECTED_STATE_INCOMPLETE")).toBe(false);
  });

  it("18 comparable field present but counterpart undefined -> UNKNOWN, never DRIFTED", async () => {
    const result = await run({
      readReleaseState: async () => expectedState(),
      inspectContainer: async () => null,
      readCatalog: async () => catalog({ catalogHash: undefined, catalogVersion: undefined, toolCount: undefined }) as never,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(findingsOf(result).filter((f) => f.severity === "critical").length).toBe(0);
  });

  it("19 mutation is structurally impossible: mutationPerformed is false for every outcome", async () => {
    const outcomes = await Promise.all([
      runVpsReconcile(),
      runVpsReconcile({ readReleaseState: async () => null }),
      runVpsReconcile({ inspectContainer: async () => container({ running: false }) as never }),
      runVpsReconcile({ readCatalog: async () => catalog({ toolCount: 999 }) as never }),
    ]);
    for (const result of outcomes) expect(result.mutationPerformed).toBe(false);
  });
});

// ---- Pro-specific certification ----

describe("pro catalog snapshot (deterministic actual state)", () => {
  it("is deterministic and order-independent (sorted before hashing)", () => {
    const a = createProCatalogSnapshot(["engineering.vps.reconcile", "engineering.vps.doctor", "engineering.app.health"]);
    const b = createProCatalogSnapshot(["engineering.app.health", "engineering.vps.doctor", "engineering.vps.reconcile"]);
    expect(a).toEqual(b);
    expect(a.toolCount).toBe(3);
    expect(a.catalogVersion).toBe(PRO_CATALOG_VERSION);
    expect(a.catalogHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the tool list changes (drift is detectable)", () => {
    const a = createProCatalogSnapshot(["engineering.vps.health"]);
    const b = createProCatalogSnapshot(["engineering.vps.health", "engineering.vps.capacity"]);
    expect(a.catalogHash).not.toBe(b.catalogHash);
    expect(a.toolCount).toBe(1);
    expect(b.toolCount).toBe(2);
  });
});

describe("default expected-state reader (operator-configured file)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("returns null when the operator env is absent (fail-closed, no throw)", async () => {
    const result = await defaultReadReleaseState(() => undefined);
    expect(result).toBeNull();
  });

  it("reads the operator-configured release-state file raw", async () => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    const file = join(dir, "release-state.json");
    writeFileSync(file, JSON.stringify({ toolCount: 13, catalogVersion: PROD_CATALOG_VERSION, deployStatus: "PASS" }), "utf8");
    const result = await defaultReadReleaseState((name) =>
      name === RECONCILE_RELEASE_STATE_FILE_ENV ? file : undefined,
    );
    expect(result).toEqual({ toolCount: 13, catalogVersion: PROD_CATALOG_VERSION, deployStatus: "PASS" });
  });

  it("swallows missing/invalid files -> null (never throws, never drifts)", async () => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
    const missing = await defaultReadReleaseState(() => join(dir!, "does-not-exist.json"));
    expect(missing).toBeNull();
    const invalidFile = join(dir, "invalid.json");
    writeFileSync(invalidFile, "{not json", "utf8");
    const invalid = await defaultReadReleaseState(() => invalidFile);
    expect(invalid).toBeNull();
  });
});

describe("strict input and output contract (zero authority in input)", () => {
  it("input schema accepts exactly {} and nothing else", () => {
    expect(vpsReconcileInputSchema.safeParse({}).success).toBe(true);
    // zero arbitrary target / credential / URL / tool selection / command / shell / SSH / path:
    for (const extra of [
      { target: "gateway" },
      { applicationId: "app-1" },
      { applicationName: "Gateway" },
      { credential: "fake-credential" },
      { url: "https://backend.example" },
      { backend: "https://backend.example" },
      { toolName: "application-redeploy" },
      { command: "rm -rf /" },
      { shell: true },
      { ssh: true },
      { path: "C:/secret" },
      { execute: true },
      { approval: { approved: true, proposalFingerprint: "0".repeat(64) } },
      { host: "10.0.0.1" },
      { token: "x" },
    ]) {
      expect(vpsReconcileInputSchema.safeParse(extra).success).toBe(false);
    }
  });

  it("output schema accepts the certified result shape", () => {
    const probe = {
      status: "IN_SYNC" as const,
      expected: {},
      actual: { container: null, catalog: { catalogHash: "h", catalogVersion: "v", toolCount: 13 } },
      findings: [{ code: "ROLLBACK_DETECTED", severity: "info" as const, expected: "PASS" }],
      mutationPerformed: false as const,
    };
    expect(vpsReconcileOutputSchema.safeParse(probe).success).toBe(true);
    expect(vpsReconcileOutputSchema.safeParse({ ...probe, mutationPerformed: true }).success).toBe(false);
    expect(vpsReconcileOutputSchema.safeParse({ ...probe, status: "MUTATED" }).success).toBe(false);
  });
});
