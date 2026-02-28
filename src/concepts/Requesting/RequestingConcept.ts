import { Hono } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { Collection, Db } from "npm:mongodb";
import { freshID } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import "jsr:@std/dotenv/load";

/**
 * # Requesting concept configuration
 * The following environment variables are available:
 *
 * - PORT: the port to the server binds, default 10000
 * - REQUESTING_BASE_URL: the base URL prefix for api requests, default "/api"
 * - REQUESTING_SAVE_RESPONSES: whether to persist responses or not, default true
 */
const PORT = parseInt(Deno.env.get("PORT") ?? "8000", 10);
const REQUESTING_BASE_URL = Deno.env.get("REQUESTING_BASE_URL") ?? "/api";

// TODO: make sure you configure this environment variable for proper CORS configuration
const REQUESTING_ALLOWED_DOMAIN = Deno.env.get("REQUESTING_ALLOWED_DOMAIN") ??
  "*";

// Choose whether or not to persist responses
const REQUESTING_SAVE_RESPONSES = Deno.env.get("REQUESTING_SAVE_RESPONSES") ??
  true;

const PREFIX = "Requesting" + ".";
const GEMINI_API_BASE = Deno.env.get("GEMINI_API_BASE") ??
  "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_TIER_CHECK_MODEL = Deno.env.get("GEMINI_TIER_CHECK_MODEL") ??
  Deno.env.get("GEMINI_MODEL_PRO") ??
  Deno.env.get("GEMINI_MODEL") ??
  "gemini-2.5-pro";
const GEMINI_VERIFY_TIMEOUT_MS = parseInt(
  Deno.env.get("GEMINI_VERIFY_TIMEOUT_MS") ?? "60000",
  10,
);
const GEMINI_VERIFY_CACHE_TTL_MS = parseInt(
  Deno.env.get("GEMINI_VERIFY_CACHE_TTL_MS") ?? "300000",
  10,
);
const GEMINI_VERIFY_FAILURE_CACHE_TTL_MS = parseInt(
  Deno.env.get("GEMINI_VERIFY_FAILURE_CACHE_TTL_MS") ?? "60000",
  10,
);
const REDACTED = "[REDACTED]";

type GeminiTier = "1" | "2" | "3";
interface GeminiModelInfo {
  name: string;
  supportedGenerationMethods?: string[];
}
type GeminiCredentialCheckResult =
  | { ok: true }
  | {
    ok: false;
    statusCode: 400 | 503;
    error: string;
  };

const geminiCredentialCache = new Map<
  string,
  { expiresAt: number; result: GeminiCredentialCheckResult }
>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeGeminiModel(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function sanitizeTier(tier: unknown): string {
  if (typeof tier !== "string") return "";
  return tier.trim();
}

function normalizeModelName(value: string): string {
  return value.startsWith("models/") ? value : `models/${value}`;
}

function shortModelName(value: string): string {
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function parseGeminiTier(tier: unknown): GeminiTier | null {
  const normalized = sanitizeTier(tier);
  if (normalized === "1" || normalized === "2" || normalized === "3") {
    return normalized;
  }
  return null;
}

function shouldRedactKey(key: string): boolean {
  return /(?:password|secret|token|authorization|api[_-]?key|geminikey|access[_-]?token|refresh[_-]?token|jwt)/i
    .test(key);
}

function shouldRedactString(value: string): boolean {
  return (
    /^AIza[0-9A-Za-z\-_]{20,}$/.test(value) ||
    /^Bearer\s+[A-Za-z0-9\-_\.=]+$/i.test(value)
  );
}

function sanitizeForPersistence(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __binary: true,
      byteLength: value.byteLength,
      kind: "Uint8Array",
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      __binary: true,
      byteLength: value.byteLength,
      kind: "ArrayBuffer",
    };
  }
  if (value instanceof Blob) {
    return {
      __binary: true,
      byteLength: value.size,
      kind: value instanceof File ? "File" : "Blob",
      mimeType: value.type || "application/octet-stream",
      fileName: value instanceof File ? value.name : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForPersistence(item));
  }
  if (isObject(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (shouldRedactKey(key)) {
        sanitized[key] = REDACTED;
        continue;
      }
      sanitized[key] = sanitizeForPersistence(entry);
    }
    return sanitized;
  }
  if (typeof value === "string" && shouldRedactString(value)) {
    return REDACTED;
  }
  return value;
}

function extractGeminiErrorMessage(payloadText: string): string {
  const trimmed = payloadText.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (isObject(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Fall back to raw payload.
  }
  return trimmed.slice(0, 500);
}

function looksLikeInvalidApiKey(message: string): boolean {
  return /(api key not valid|invalid api key|api[_\s-]?key[_\s-]?invalid|unauthenticated|invalid authentication)/i
    .test(message);
}

function looksLikeInsufficientTier(message: string): boolean {
  return /(free tier|upgrade|billing|payment|not available.*(?:plan|tier)|requires.*(?:plan|tier)|insufficient.*(?:plan|tier)|quota.*(?:free|plan))/i
    .test(message);
}

function parseGeminiModelList(payloadText: string): GeminiModelInfo[] | null {
  try {
    const parsed = JSON.parse(payloadText) as Record<string, unknown>;
    if (!Array.isArray(parsed.models)) return [];
    const models: GeminiModelInfo[] = [];
    for (const model of parsed.models) {
      if (!isObject(model)) continue;
      if (typeof model.name !== "string" || model.name.trim().length === 0) {
        continue;
      }
      const supportedGenerationMethods = Array.isArray(
          model.supportedGenerationMethods,
        )
        ? model.supportedGenerationMethods.filter((entry): entry is string =>
          typeof entry === "string"
        )
        : undefined;
      models.push({
        name: normalizeModelName(model.name.trim()),
        supportedGenerationMethods,
      });
    }
    return models;
  } catch {
    return null;
  }
}

function modelSupportsGenerateContent(model: GeminiModelInfo): boolean {
  if (!Array.isArray(model.supportedGenerationMethods)) return true;
  return model.supportedGenerationMethods.some((method) =>
    method.toLowerCase() === "generatecontent"
  );
}

function evaluateProbeModelCapability(
  models: GeminiModelInfo[] | null,
  probeModel: string,
): "supported" | "unsupported" | "unknown" {
  if (models === null) return "unknown";
  const normalizedProbe = normalizeModelName(probeModel).toLowerCase();
  const shortProbe = shortModelName(probeModel).toLowerCase();
  for (const model of models) {
    const normalizedName = normalizeModelName(model.name).toLowerCase();
    const shortName = shortModelName(model.name).toLowerCase();
    if (normalizedName === normalizedProbe || shortName === shortProbe) {
      return modelSupportsGenerateContent(model)
        ? "supported"
        : "unsupported";
    }
  }
  return "unsupported";
}

function isPipelineTriggerRoute(path: string, method: string): boolean {
  if (method === "POST" && path === "/projects") return true;
  if (method === "POST" && /^\/projects\/[^/]+\/clarify$/.test(path)) {
    return true;
  }
  if (method === "PUT" && /^\/projects\/[^/]+\/plan$/.test(path)) return true;
  if (
    (method === "POST" || method === "PUT") &&
    /^\/projects\/[^/]+\/design$/.test(path)
  ) {
    return true;
  }
  if (method === "POST" && /^\/projects\/[^/]+\/implement$/.test(path)) {
    return true;
  }
  if (method === "POST" && /^\/projects\/[^/]+\/syncs$/.test(path)) return true;
  if (method === "POST" && /^\/projects\/[^/]+\/assemble$/.test(path)) {
    return true;
  }
  if (method === "POST" && /^\/projects\/[^/]+\/build$/.test(path)) return true;
  return false;
}

function isBuildStatusRoute(path: string, method: string): boolean {
  if (method !== "GET") return false;
  return /^\/projects\/[^/]+\/(?:build|assemble)\/status$/.test(path);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fingerprintGeminiKey(apiKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hash.slice(0, 24);
}

async function verifyGeminiKeyAndTier(
  apiKey: string,
  tier: GeminiTier,
): Promise<GeminiCredentialCheckResult> {
  const fingerprint = await fingerprintGeminiKey(apiKey);
  const cacheKey = `${fingerprint}:${tier}:${GEMINI_TIER_CHECK_MODEL}`;
  const now = Date.now();
  const cached = geminiCredentialCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const normalizedModel = normalizeGeminiModel(GEMINI_TIER_CHECK_MODEL);
  const modelListUrl = `${GEMINI_API_BASE}/models?key=${
    encodeURIComponent(apiKey)
  }`;
  let modelListResp: Response;
  try {
    modelListResp = await fetchWithTimeout(
      modelListUrl,
      { method: "GET" },
      GEMINI_VERIFY_TIMEOUT_MS,
    );
  } catch {
    return {
      ok: false,
      statusCode: 503,
      error:
        "Unable to verify Gemini credentials right now. Please retry shortly.",
    };
  }

  const modelListPayload = await modelListResp.text();
  if (!modelListResp.ok) {
    const message = extractGeminiErrorMessage(modelListPayload);
    if (
      modelListResp.status === 400 || modelListResp.status === 401 ||
      modelListResp.status === 403 || looksLikeInvalidApiKey(message)
    ) {
      const result: GeminiCredentialCheckResult = {
        ok: false,
        statusCode: 400,
        error: "Invalid Gemini API key.",
      };
      geminiCredentialCache.set(cacheKey, {
        expiresAt: now + GEMINI_VERIFY_FAILURE_CACHE_TTL_MS,
        result,
      });
      return result;
    }
    return {
      ok: false,
      statusCode: 503,
      error:
        "Gemini credential verification is temporarily unavailable. Please retry.",
    };
  }

  const modelCapability = evaluateProbeModelCapability(
    parseGeminiModelList(modelListPayload),
    normalizedModel,
  );
  if (modelCapability === "unsupported") {
    const result: GeminiCredentialCheckResult = {
      ok: false,
      statusCode: 400,
      error:
        "Gemini API key does not meet required paid tier access (tier 0/free is unsupported).",
    };
    geminiCredentialCache.set(cacheKey, {
      expiresAt: now + GEMINI_VERIFY_FAILURE_CACHE_TTL_MS,
      result,
    });
    return result;
  }

  const probeUrl = `${GEMINI_API_BASE}/${normalizedModel}:generateContent?key=${
    encodeURIComponent(apiKey)
  }`;
  let probeResp: Response;
  try {
    probeResp = await fetchWithTimeout(
      probeUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      },
      GEMINI_VERIFY_TIMEOUT_MS,
    );
  } catch {
    return {
      ok: false,
      statusCode: 503,
      error:
        "Unable to verify Gemini plan capability right now. Please retry shortly.",
    };
  }

  if (probeResp.ok) {
    const result: GeminiCredentialCheckResult = { ok: true };
    geminiCredentialCache.set(cacheKey, {
      expiresAt: now + GEMINI_VERIFY_CACHE_TTL_MS,
      result,
    });
    return result;
  }

  const probePayload = await probeResp.text();
  const probeMessage = extractGeminiErrorMessage(probePayload);
  const isInvalid = looksLikeInvalidApiKey(probeMessage) ||
    probeResp.status === 401;
  if (isInvalid) {
    const result: GeminiCredentialCheckResult = {
      ok: false,
      statusCode: 400,
      error: "Invalid Gemini API key.",
    };
    geminiCredentialCache.set(cacheKey, {
      expiresAt: now + GEMINI_VERIFY_FAILURE_CACHE_TTL_MS,
      result,
    });
    return result;
  }

  const isInsufficientTier = looksLikeInsufficientTier(probeMessage) ||
    probeResp.status === 403;
  if (isInsufficientTier) {
    const result: GeminiCredentialCheckResult = {
      ok: false,
      statusCode: 400,
      error:
        "Gemini API key does not meet required paid tier access (tier 0/free is unsupported).",
    };
    geminiCredentialCache.set(cacheKey, {
      expiresAt: now + GEMINI_VERIFY_FAILURE_CACHE_TTL_MS,
      result,
    });
    return result;
  }

  if (probeResp.status === 429 && looksLikeInsufficientTier(probeMessage)) {
    const result: GeminiCredentialCheckResult = {
      ok: false,
      statusCode: 400,
      error:
        "Gemini API key does not meet required paid tier access (tier 0/free is unsupported).",
    };
    geminiCredentialCache.set(cacheKey, {
      expiresAt: now + GEMINI_VERIFY_FAILURE_CACHE_TTL_MS,
      result,
    });
    return result;
  }

  return {
    ok: false,
    statusCode: 503,
    error: "Gemini tier verification is temporarily unavailable. Please retry.",
  };
}

async function validateGeminiCredentials(
  apiKeyRaw: unknown,
  tierRaw: unknown,
): Promise<GeminiCredentialCheckResult> {
  const apiKey = typeof apiKeyRaw === "string" ? apiKeyRaw.trim() : "";
  const tier = sanitizeTier(tierRaw);

  if (!apiKey) {
    return {
      ok: false,
      statusCode: 400,
      error: "Missing required header: X-Gemini-Api-Key.",
    };
  }
  if (!tier) {
    return {
      ok: false,
      statusCode: 400,
      error: "Missing required header: X-Gemini-Tier.",
    };
  }
  const parsedTier = parseGeminiTier(tier);
  if (!parsedTier) {
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid Gemini tier. Allowed values are 1, 2, or 3.",
    };
  }
  return await verifyGeminiKeyAndTier(apiKey, parsedTier);
}

export const requestingTestables = {
  parseGeminiTier,
  parseGeminiModelList,
  evaluateProbeModelCapability,
  sanitizeForPersistence,
  validateGeminiCredentials,
  probeModel: normalizeGeminiModel(GEMINI_TIER_CHECK_MODEL),
  clearGeminiCredentialCache: () => {
    geminiCredentialCache.clear();
  },
};

// --- Type Definitions ---
type Request = ID;

/**
 * a set of Requests with
 *   an input unknown
 *   an optional response unknown
 */
interface RequestDoc {
  _id: Request;
  input: { path: string; [key: string]: unknown };
  response?: unknown;
  createdAt: Date;
}

/**
 * Represents an in-flight request waiting for a response.
 * This state is not persisted and lives only in memory.
 */
interface PendingRequest {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

/**
 * The Requesting concept encapsulates an API server, modeling incoming
 * requests and outgoing responses as concept actions.
 */
export default class RequestingConcept {
  private readonly requests: Collection<RequestDoc>;
  private readonly pending: Map<Request, PendingRequest> = new Map();
  // Keep raw request inputs in-memory while requests are in flight so
  // syncs can read non-redacted values (for example accessToken).
  private readonly liveInputs: Map<
    Request,
    { path: string; [key: string]: unknown }
  > = new Map();

  constructor(private readonly db: Db) {
    this.requests = this.db.collection(PREFIX + "requests");
    console.log(`\nRequesting concept initialized (no request timeout).`);
  }

  /**
   * request (path: String, ...): (request: Request)
   * System action triggered by an external HTTP request.
   *
   * **requires** true
   *
   * **effects** creates a new Request `r`; sets the input of `r` to be the path and all other input parameters; returns `r` as `request`
   */
  async request(
    inputs: { path: string; [key: string]: unknown },
  ): Promise<{ request: Request }> {
    const requestId = freshID() as Request;
    const persistedInput = sanitizeForPersistence(inputs) as {
      path: string;
      [key: string]: unknown;
    };
    const requestDoc: RequestDoc = {
      _id: requestId,
      input: persistedInput,
      createdAt: new Date(),
    };

    // Persist the request for logging/auditing purposes.
    await this.requests.insertOne(requestDoc);

    // Create an in-memory pending request to manage the async response.
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.pending.set(requestId, { promise, resolve, reject });
    this.liveInputs.set(requestId, { ...inputs });

    return { request: requestId };
  }

  /**
   * respond (request: Request, [key: string]: unknown)
   *
   * **requires** a Request with the given `request` id exists and has no response yet
   *
   * **effects** sets the response of the given Request to the provided key-value pairs.
   */
  async respond(
    { request, ...response }: { request: Request; [key: string]: unknown },
  ): Promise<{ request: string }> {
    const pendingRequest = this.pending.get(request);
    if (pendingRequest) {
      // Resolve the promise for any waiting `_awaitResponse` call.
      pendingRequest.resolve(response);
    }

    if (REQUESTING_SAVE_RESPONSES) {
      const hasStream = response &&
        typeof response === "object" &&
        "stream" in response &&
        typeof response.stream === "object" &&
        response.stream !== null;
      const toPersist = hasStream
        ? { ...response, stream: "[Stream]" }
        : response;
      try {
        await this.requests.updateOne(
          { _id: request },
          { $set: { response: toPersist } },
        );
      } catch {
        // Non-serializable responses (streams, etc.) can cause BSON overflow
      }
    }

    return { request };
  }

  /**
   * _awaitResponse (request: Request): (response: unknown)
   *
   * **effects** returns the response associated with the given request, waiting until the response is available.
   */
  async _awaitResponse(
    { request }: { request: Request },
  ): Promise<{ response: unknown }[]> {
    const pendingRequest = this.pending.get(request);

    if (!pendingRequest) {
      // The request might have been processed already or never existed.
      throw new Error(
        `Request ${request} is not pending or does not exist.`,
      );
    }

    try {
      const response = await pendingRequest.promise;
      return [{ response }];
    } finally {
      this.pending.delete(request);
      this.liveInputs.delete(request);
    }
  }

  /**
   * _getInput (request: Request): (input: Object)
   *
   * **effects** returns the original request input.
   * If the request is still in-flight, returns the in-memory raw input;
   * otherwise falls back to the persisted (sanitized) input.
   */
  async _getInput(
    { request }: { request: Request },
  ): Promise<Array<{ input: { path: string; [key: string]: unknown } }>> {
    const liveInput = this.liveInputs.get(request);
    if (liveInput) {
      return [{ input: liveInput }];
    }

    const doc = await this.requests.findOne(
      { _id: request },
      { projection: { input: 1 } },
    );
    if (!doc) return [];
    return [{ input: doc.input }];
  }

  /**
   * _getPendingRequestsByPaths(paths: string[], method?: string): (request: Request)
   *
   * **effects** returns request IDs that are still pending and whose input path
   * matches one of the provided paths.
   */
  async _getPendingRequestsByPaths(
    { paths, method }: { paths: string[]; method?: string },
  ): Promise<Array<{ request: Request }>> {
    if (!Array.isArray(paths) || paths.length === 0) return [];

    const query: Record<string, unknown> = {
      "input.path": { $in: paths },
      response: { $exists: false },
    };
    if (method !== undefined) {
      query["input.method"] = method;
    }

    const docs = await this.requests.find(
      query,
      { projection: { _id: 1 } },
    ).toArray();

    return docs
      .map((doc) => doc._id as Request)
      // Only return requests that are still actively pending in memory.
      .filter((request) => this.pending.has(request))
      .map((request) => ({ request }));
  }
}

/**
 * Starts the Hono web server that listens for incoming requests and pipes them
 * into the Requesting concept instance. Additionally, it allows passthrough
 * requests to concept actions by default. These should be
 * @param concepts The complete instantiated concepts import from "@concepts"
 */
export function startRequestingServer(
  // deno-lint-ignore no-explicit-any
  concepts: Record<string, any>,
) {
  // deno-lint-ignore no-unused-vars
  const { Requesting, client, db, Engine, ...instances } = concepts;
  if (!(Requesting instanceof RequestingConcept)) {
    throw new Error("Requesting concept missing or broken.");
  }
  const app = new Hono();
  app.use(
    "/*",
    cors({
      origin: REQUESTING_ALLOWED_DOMAIN,
    }),
  );

  /**
   * REQUESTING ROUTES
   *
   * Captures all POST routes under the base URL.
   * The specific action path is extracted from the URL.
   */

  // Support GET, POST, PUT, DELETE
  const routePath = `${REQUESTING_BASE_URL}/*`;
  const handler = async (c: any) => {
    try {
      // Parse body if it exists — supports JSON and multipart/form-data
      let body: Record<string, unknown> = {};
      if (c.req.method !== "GET" && c.req.method !== "DELETE") {
        const contentType = c.req.header("Content-Type") ?? "";

        if (contentType.includes("multipart/form-data")) {
          try {
            // Hono's parseBody returns text fields as strings and file fields as File objects
            const parsed = await c.req.parseBody({ all: true });
            for (const [key, value] of Object.entries(parsed)) {
              if (value instanceof File) {
                // Keep multipart file payloads as raw bytes to avoid base64 inflation.
                const buf = await value.arrayBuffer();
                body[key] = new Uint8Array(buf);
                body[key + "MimeType"] = value.type ||
                  "application/octet-stream";
                body[key + "FileName"] = value.name || "unknown";
                body[key + "Size"] = value.size;
              } else if (
                Array.isArray(value) &&
                value.every((entry) => entry instanceof File)
              ) {
                const files = value as File[];
                body[key] = await Promise.all(files.map(async (file) =>
                  new Uint8Array(await file.arrayBuffer())
                ));
                body[key + "MimeTypes"] = files.map((file) =>
                  file.type || "application/octet-stream"
                );
                body[key + "FileNames"] = files.map((file) =>
                  file.name || "unknown"
                );
                body[key + "Sizes"] = files.map((file) => file.size);
              } else {
                body[key] = value;
              }
            }
          } catch {
            // Fall back to empty body on parse failure
          }
        } else {
          try {
            body = await c.req.json();
          } catch {
            // ignore JSON parse error for empty body
          }
        }
      }

      if (typeof body !== "object" || body === null) {
        return c.json(
          { error: "Invalid request body. Must be a JSON object." },
          400,
        );
      }

      // Extract the specific action path from the request URL.
      // e.g., if base is /api and request is /api/users/create, path is /users/create
      const actionPath = c.req.path.substring(REQUESTING_BASE_URL.length);

      // Parse query parameters
      const queryParams = c.req.query();

      // Combine the path from the URL with the JSON body and query parameters to form the action's input.
      const inputs: { path: string; [key: string]: any } = {
        ...queryParams,
        ...body,
        path: actionPath,
        method: c.req.method,
      };

      const geminiKeyHeader = c.req.header("X-Gemini-Api-Key");
      const geminiTierHeader = c.req.header("X-Gemini-Tier");
      inputs.geminiKey = typeof geminiKeyHeader === "string"
        ? geminiKeyHeader.trim()
        : "";
      inputs.geminiTier = typeof geminiTierHeader === "string"
        ? geminiTierHeader.trim()
        : "";

      // Extract Access Token from Header if present
      const authHeader = c.req.header("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        inputs.accessToken = authHeader.substring(7);
      }
      const rangeHeader = c.req.header("Range");
      if (typeof rangeHeader === "string" && rangeHeader.trim().length > 0) {
        inputs.range = rangeHeader.trim();
      }

      if (isPipelineTriggerRoute(inputs.path, inputs.method)) {
        const normalizedTier = sanitizeTier(inputs.geminiTier);
        // Tier 0 is rejected by sync-level guards so requests never trigger
        // sandbox pipeline concepts.
        if (normalizedTier !== "0") {
          const validation = await validateGeminiCredentials(
            inputs.geminiKey,
            inputs.geminiTier,
          );
          if (!validation.ok) {
            return c.json({ error: validation.error }, validation.statusCode);
          }
        }
      } else if (isBuildStatusRoute(inputs.path, inputs.method)) {
        const hasAnyGeminiCredentials = inputs.geminiKey || inputs.geminiTier;
        const normalizedTier = sanitizeTier(inputs.geminiTier);
        if (hasAnyGeminiCredentials && normalizedTier !== "0") {
          const validation = await validateGeminiCredentials(
            inputs.geminiKey,
            inputs.geminiTier,
          );
          if (!validation.ok) {
            return c.json({ error: validation.error }, validation.statusCode);
          }
        }
      }

      console.log(
        `[Requesting] Received ${c.req.method} request for path: ${inputs.path}`,
      );

      // 1. Trigger the 'request' action.
      const { request } = await Requesting.request(inputs);

      // 2. Await the response via the query. This is where the server waits for
      //    synchronizations to trigger the 'respond' action.
      const responseArray = await Requesting._awaitResponse({ request });

      // 3. Send the response back to the client.
      const { response } = responseArray[0];

      // Check for Stream response
      if (
        response && typeof response === "object" && "stream" in response &&
        response.stream instanceof ReadableStream
      ) {
        const { stream, headers, statusCode } = response as any;
        return new Response(stream, {
          headers: headers || {},
          status: typeof statusCode === "number" ? statusCode : 200,
        });
      }

      // Check for statusCode in response
      if (
        response && typeof response === "object" && "statusCode" in response
      ) {
        const { statusCode, ...rest } = response as any;
        return c.json(rest, statusCode);
      }

      return c.json(response);
    } catch (e: any) {
      if (e instanceof Error) {
        console.error(`[Requesting] Error processing request:`, e.message);
        return c.json({ error: "An internal server error occurred." }, 500);
      } else {
        return c.json({ error: "unknown error occurred." }, 418);
      }
    }
  };

  app.all(routePath, handler);

  console.log(
    `\n🚀 Requesting server listening for ALL requests at base path of ${routePath}`,
  );

  Deno.serve({ port: PORT }, app.fetch);
}
