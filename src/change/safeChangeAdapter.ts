/**
 * SafeChangeAdapter - the SINGLE private component that holds mutation
 * authority for engineering.vps.change.safe.
 *
 * This module is the minimal executable boundary transformed from the
 * documentation-only FutureSafeChangeAdapter. It exists to reuse the PROVEN
 * mutation capability (application-redeploy through the agentMemoryBridge
 * mcp_execute channel, the exact channel the certified ENG-MCP
 * engineering.vps.change.safe used) without redesigning the product.
 *
 * Security boundary of this file (the ONLY place with network/mutation
 * authority in this process):
 * - Exactly ONE capability exists: redeploy(resolved, correlationKey). There
 *   is no generic execute, no tool selection, no arbitrary operation and no
 *   second mutating tool. The mutation allowlist is closed at compile time:
 *   CHANGE_MUTATION_TOOL is the literal 'application-redeploy'.
 * - redeploy() accepts ONLY operator-resolved targets (ResolvedApplicationTarget
 *   built from the operator allowlist). It NEVER accepts agent input, never
 *   accepts credentials or URLs from callers, and never returns them.
 * - The backend URL and credential are OPERATOR-CONFIGURED at construction
 *   time (environment variables). They are never agent input, never part of
 *   any tool output and never logged.
 * - The transport is injectable so tests use deterministic fakes; no test or
 *   smoke ever touches a real VPS/Dokploy.
 * - Exactly ONE mutation attempt per call: no retry, no fallback, no
 *   auto-recovery, no polling, no watch loop.
 * - accepted=true means only that the backend call completed without an
 *   upstream error. It is NEVER verified success; mandatory post-validation
 *   in changeSafe.ts re-reads evidence and classifies honestly.
 * - Responses are redacted (sensitive keys stripped, bounded depth/size)
 *   before they can reach any result or log.
 */
import type { ResolvedApplicationTarget } from "./changeSafe";

/** The single mutating tool this process may ever call. Closed allowlist. */
export const CHANGE_MUTATION_TOOL = "application-redeploy" as const;

// ---------------------------------------------------------------------------
// Transport contract (injectable; narrowed port of the certified ENG-MCP
// VpsTransport). The transport carries the ONLY network authority.
// ---------------------------------------------------------------------------

export interface SafeChangeTransportCall {
  readonly toolName: typeof CHANGE_MUTATION_TOOL;
  readonly arguments: { readonly applicationId: string };
  readonly mutating: true;
  readonly confirmation: { readonly toolName: typeof CHANGE_MUTATION_TOOL };
}

export interface SafeChangeTransportResponse {
  readonly ok: boolean;
  readonly status: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly durationMs: number;
}

export interface SafeChangeTransport {
  readonly name: string;
  call(request: SafeChangeTransportCall): Promise<SafeChangeTransportResponse>;
}

// ---------------------------------------------------------------------------
// Adapter contract (the minimal executable boundary).
// ---------------------------------------------------------------------------

export interface SafeChangeOutcome {
  /** Transport-level acceptance by the backend. NOT verified success. */
  readonly accepted: boolean;
  readonly ref: string | null;
  readonly message: string;
}

export interface SafeChangeAdapter {
  readonly name: string;
  /**
   * The single mutation capability. `resolved` comes ONLY from the operator
   * allowlist; `correlationKey` is the approved proposalFingerprint, used as
   * the local correlation/action key (backend idempotency is NOT claimed).
   */
  redeploy(resolved: ResolvedApplicationTarget, correlationKey: string): Promise<SafeChangeOutcome>;
}

// ---------------------------------------------------------------------------
// Operator configuration (construction time; NEVER agent input).
// ---------------------------------------------------------------------------

export const CHANGE_BACKEND_URL_ENV = "MEMORYOS_VPS_GUARDIAN_CHANGE_BACKEND_URL";
export const CHANGE_BACKEND_CREDENTIAL_ENV = "MEMORYOS_VPS_GUARDIAN_CHANGE_CREDENTIAL";
export const CHANGE_BACKEND_SERVER_ID_ENV = "MEMORYOS_VPS_GUARDIAN_CHANGE_SERVER_ID";
export const CHANGE_BACKEND_SERVER_ID_DEFAULT = "6a8dc3a3beadf81a8ed535cc";

// Timing and size guards (ported from the certified ENG-MCP implementation).
const DEFAULT_CALL_TIMEOUT_MS = 20_000;
const MAX_CALL_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_REDACTION_DEPTH = 8;
const MAX_STRING_LENGTH = 2_000;

/**
 * Recursive redaction of sensitive KEYS (ported from the certified ENG-MCP
 * implementation). The pattern matches the exact key '^env$' so that fields
 * like environmentId still pass through.
 */
const SENSITIVE_KEY_PATTERN = /authorization|token|secret|api_?key|password|cookie|bearer|envvars|^env$/i;

function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    return "[depth-limit]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSensitive(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitive(val, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }
  return value;
}

/** Unwraps an MCP tool result: structuredContent, or single JSON text content. */
function normalizeMcpResult(result: unknown): unknown {
  if (result === null || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (record.structuredContent !== undefined) {
    return record.structuredContent;
  }
  if (Array.isArray(record.content) && record.content.length > 0) {
    const first = record.content[0] as Record<string, unknown> | undefined;
    if (first !== undefined && typeof first.text === "string") {
      try {
        return JSON.parse(first.text) as unknown;
      } catch {
        return first.text;
      }
    }
  }
  return result;
}

/** Best-effort correlation ref extraction from a redacted backend result. */
function extractRef(result: unknown): string | null {
  if (result === null || typeof result !== "object") {
    return null;
  }
  const record = result as Record<string, unknown>;
  for (const key of ["deployId", "ref", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

export interface McpBridgeTransportOptions {
  /** Operator-configured bridge endpoint (construction time, never logged). */
  readonly endpointUrl: string;
  /** Operator-configured credential (construction time, never logged). */
  readonly credential: string;
  /** Operator-configured bridge serverId (closed allowlist on the bridge side). */
  readonly serverId: string;
  readonly timeoutMs?: number;
  /** Injectable for deterministic tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Proven bridge transport: POST { serverId, operation: 'mcp_execute', toolName,
 * arguments, confirmation } with the credential in the x-agent-memory-token
 * header. Behavior ported from the certified ENG-MCP transport: redirect
 * disabled, hard timeout, bounded response, strict error mapping, redaction.
 * The URL and credential are never included in any response, error or log.
 */
export function createMcpBridgeCallTransport(options: McpBridgeTransportOptions): SafeChangeTransport {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, 1), MAX_CALL_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(options.endpointUrl);
  if (!url.pathname.endsWith("/agentMemoryBridge")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/agentMemoryBridge`;
  }
  return {
    name: "mcp-agent-memory-bridge",
    async call(request: SafeChangeTransportCall): Promise<SafeChangeTransportResponse> {
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-memory-token": options.credential,
          },
          body: JSON.stringify({
            serverId: options.serverId,
            operation: "mcp_execute",
            toolName: request.toolName,
            arguments: request.arguments,
            confirmation: request.confirmation,
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        const durationMs = Date.now() - startedAt;
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
          return {
            ok: false,
            status: "GATEWAY_RESPONSE_TOO_LARGE",
            error: `response exceeded ${MAX_RESPONSE_BYTES} bytes`,
            durationMs,
          };
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = null;
        }
        if (!response.ok) {
          const failure = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
          const errCode =
            typeof failure.error === "string" && failure.error.length > 0
              ? failure.error
              : typeof failure.code === "string" && failure.code.length > 0
                ? failure.code
                : undefined;
          const errText = typeof failure.message === "string" ? failure.message : undefined;
          return {
            ok: false,
            status: errCode ?? `HTTP_${response.status}`,
            error: errText === undefined ? `upstream returned HTTP ${response.status}` : (redactSensitive(errText) as string),
            durationMs,
          };
        }
        if (parsed === null) {
          return {
            ok: false,
            status: "GATEWAY_INVALID_RESPONSE",
            error: "upstream returned a non-JSON body",
            durationMs,
          };
        }
        const envelope = parsed as Record<string, unknown>;
        // Bridge semantics: ok:true means the tool call completed WITHOUT
        // THROWING. It is NOT verified success; post-validation decides.
        const bridgeError =
          typeof envelope.error === "string" && envelope.error.length > 0 ? envelope.error : null;
        if (envelope.ok !== true || bridgeError !== null) {
          return {
            ok: false,
            status: bridgeError ?? "GATEWAY_CALL_FAILED",
            error: bridgeError ?? "bridge did not report ok:true",
            durationMs,
          };
        }
        return {
          ok: true,
          status: "OK",
          result: redactSensitive(normalizeMcpResult(envelope.result)),
          durationMs,
        };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : "unknown transport failure";
        if (error instanceof Error && error.name === "TimeoutError") {
          return { ok: false, status: "GATEWAY_TIMEOUT", error: message, durationMs };
        }
        return { ok: false, status: "GATEWAY_NETWORK_ERROR", error: message, durationMs };
      }
    },
  };
}

export interface McpBridgeSafeChangeAdapterOptions {
  readonly transport: SafeChangeTransport;
}

/**
 * The SafeChangeAdapter over the proven bridge transport: ONE capability
 * (redeploy), ONE tool (application-redeploy), ONE attempt (no retry).
 * The only audit emitted is metadata-only (no applicationId, no URL, no
 * credential).
 */
export function createMcpBridgeSafeChangeAdapter(options: McpBridgeSafeChangeAdapterOptions): SafeChangeAdapter {
  const transport = options.transport;
  return {
    name: `safe-change:${transport.name}`,
    async redeploy(resolved: ResolvedApplicationTarget, correlationKey: string): Promise<SafeChangeOutcome> {
      // Exactly ONE mutation attempt. No retry, no fallback, no recovery.
      const response = await transport.call({
        toolName: CHANGE_MUTATION_TOOL,
        arguments: { applicationId: resolved.applicationId },
        mutating: true,
        confirmation: { toolName: CHANGE_MUTATION_TOOL },
      });
      console.log(
        JSON.stringify({
          event: "safe-change.redeploy",
          tool: CHANGE_MUTATION_TOOL,
          correlationKey,
          accepted: response.ok,
          durationMs: response.durationMs,
        }),
      );
      if (!response.ok) {
        return {
          accepted: false,
          ref: null,
          message: `mutation call did not complete: ${response.status}${response.error === undefined ? "" : ` (${response.error})`}`,
        };
      }
      return {
        accepted: true,
        ref: extractRef(response.result),
        message: "mutation call accepted by the backend; the outcome is NOT yet verified",
      };
    },
  };
}
