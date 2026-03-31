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
 * - REQUESTING_MAX_UPLOAD_BYTES: max allowed request payload size before parsing, default 25MB
 */
const PORT = parseInt(Deno.env.get("PORT") ?? "8000", 10);
const REQUESTING_BASE_URL = Deno.env.get("REQUESTING_BASE_URL") ?? "/api";

// TODO: make sure you configure this environment variable for proper CORS configuration
const REQUESTING_ALLOWED_DOMAIN = Deno.env.get("REQUESTING_ALLOWED_DOMAIN") ??
  "*";

// Choose whether or not to persist responses
const REQUESTING_SAVE_RESPONSES = Deno.env.get("REQUESTING_SAVE_RESPONSES") ??
  true;
const REQUESTING_MAX_UPLOAD_BYTES = Number.parseInt(
  Deno.env.get("REQUESTING_MAX_UPLOAD_BYTES") ?? `${25 * 1024 * 1024}`,
  10,
);

const PREFIX = "Requesting" + ".";
const REDACTED = "[REDACTED]";
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const EXTENSION_MIME_MAP: Record<string, string> = {
  // Documents & data
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/json",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".conf": "text/plain",
  ".env": "text/plain",
  ".log": "text/plain",
  ".rtf": "text/rtf",

  // Web
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".jsx": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".vue": "text/plain",
  ".svelte": "text/plain",

  // Programming languages
  ".py": "text/x-python",
  ".pyi": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".kt": "text/x-kotlin",
  ".kts": "text/x-kotlin",
  ".scala": "text/x-scala",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".cxx": "text/x-c++",
  ".cc": "text/x-c++",
  ".hpp": "text/x-c++",
  ".cs": "text/x-csharp",
  ".swift": "text/x-swift",
  ".m": "text/x-objectivec",
  ".php": "text/x-php",
  ".pl": "text/x-perl",
  ".pm": "text/x-perl",
  ".lua": "text/x-lua",
  ".r": "text/x-r",
  ".R": "text/x-r",
  ".jl": "text/x-julia",
  ".ex": "text/x-elixir",
  ".exs": "text/x-elixir",
  ".erl": "text/x-erlang",
  ".hs": "text/x-haskell",
  ".clj": "text/x-clojure",
  ".lisp": "text/x-lisp",
  ".dart": "text/x-dart",
  ".zig": "text/plain",
  ".nim": "text/plain",
  ".v": "text/plain",

  // Shell & scripting
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".fish": "text/x-shellscript",
  ".ps1": "text/plain",
  ".bat": "text/plain",
  ".cmd": "text/plain",

  // Build & config
  ".dockerfile": "text/plain",
  ".makefile": "text/plain",
  ".cmake": "text/plain",
  ".gradle": "text/plain",
  ".tf": "text/plain",
  ".hcl": "text/plain",
  ".proto": "text/plain",
  ".graphql": "text/plain",
  ".gql": "text/plain",

  // SQL
  ".sql": "text/x-sql",

  // Binary documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",

  // Archives
  ".zip": "application/zip",
  ".gz": "application/gzip",

  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",

  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",

  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function inferMimeType(
  browserMimeType: string | undefined,
  fileName: string,
): string {
  if (browserMimeType && browserMimeType !== "application/octet-stream") {
    return browserMimeType;
  }
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex !== -1) {
    const ext = fileName.slice(dotIndex).toLowerCase();
    const mapped = EXTENSION_MIME_MAP[ext];
    if (mapped) return mapped;
  }
  return browserMimeType || "application/octet-stream";
}

function getMaxUploadBytes(): number {
  if (
    Number.isFinite(REQUESTING_MAX_UPLOAD_BYTES) &&
    REQUESTING_MAX_UPLOAD_BYTES > 0
  ) {
    return REQUESTING_MAX_UPLOAD_BYTES;
  }
  return DEFAULT_MAX_UPLOAD_BYTES;
}

function parseContentLength(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldRedactKey(key: string): boolean {
  return /(?:password|accountpassword|secret|token|authorization|api[_-]?key|geminikey|unwrap[_-]?key|ciphertext|^iv$|access[_-]?token|refresh[_-]?token|jwt)/i
    .test(key);
}

function shouldRedactContextualKey(
  parent: Record<string, unknown>,
  key: string,
): boolean {
  const path = typeof parent.path === "string" ? parent.path : "";
  if (path === "/auth/github/callback" && (key === "code" || key === "state")) {
    return true;
  }
  return false;
}

function isSensitiveUrlString(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const isGitHubHost = host === "github.com" || host === "api.github.com";
    return (
      Boolean(url.username || url.password) ||
      (isGitHubHost && (url.searchParams.has("code") || url.searchParams.has("state")))
    );
  } catch {
    return false;
  }
}

function shouldRedactString(value: string): boolean {
  return (
    /^AIza[0-9A-Za-z\-_]{20,}$/.test(value) ||
    /^Bearer\s+[A-Za-z0-9\-_\.=]+$/i.test(value) ||
    /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/.test(value) ||
    isSensitiveUrlString(value)
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
      if (shouldRedactKey(key) || shouldRedactContextualKey(value, key)) {
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

export const requestingTestables = {
  sanitizeForPersistence,
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
      const toPersist = sanitizeForPersistence(hasStream
        ? { ...response, stream: "[Stream]" }
        : response);
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
        const maxUploadBytes = getMaxUploadBytes();
        const contentLength = parseContentLength(c.req.header("Content-Length"));

        // Reject oversized payloads before any JSON/multipart parsing to avoid OOM.
        if (contentLength !== null && contentLength > maxUploadBytes) {
          return c.json(
            {
              error: `Payload too large. Max allowed is ${maxUploadBytes} bytes.`,
            },
            413,
          );
        }

        if (contentType.includes("multipart/form-data")) {
          try {
            // Hono's parseBody returns text fields as strings and file fields as File objects
            const parsed = await c.req.parseBody({ all: true });
            let seenBinaryBytes = 0;
            for (const [key, value] of Object.entries(parsed)) {
              if (value instanceof File) {
                seenBinaryBytes += value.size;
                if (seenBinaryBytes > maxUploadBytes) {
                  return c.json(
                    {
                      error:
                        `Payload too large. Max allowed is ${maxUploadBytes} bytes.`,
                    },
                    413,
                  );
                }
                const buf = await value.arrayBuffer();
                body[key] = new Uint8Array(buf);
                body[key + "MimeType"] = inferMimeType(
                  value.type,
                  value.name || "unknown",
                );
                body[key + "FileName"] = value.name || "unknown";
                body[key + "Size"] = value.size;
              } else if (
                Array.isArray(value) &&
                value.every((entry) => entry instanceof File)
              ) {
                const files = value as File[];
                seenBinaryBytes += files.reduce((sum, file) => sum + file.size, 0);
                if (seenBinaryBytes > maxUploadBytes) {
                  return c.json(
                    {
                      error:
                        `Payload too large. Max allowed is ${maxUploadBytes} bytes.`,
                    },
                    413,
                  );
                }
                body[key] = await Promise.all(files.map(async (file) =>
                  new Uint8Array(await file.arrayBuffer())
                ));
                body[key + "MimeTypes"] = files.map((file) =>
                  inferMimeType(file.type, file.name || "unknown")
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
      const geminiUnwrapKeyHeader = c.req.header("X-Gemini-Unwrap-Key");
      inputs.geminiKey = typeof geminiKeyHeader === "string"
        ? geminiKeyHeader.trim()
        : "";
      inputs.geminiTier = typeof geminiTierHeader === "string"
        ? geminiTierHeader.trim()
        : "";
      inputs.geminiUnwrapKey = typeof geminiUnwrapKeyHeader === "string"
        ? geminiUnwrapKeyHeader.trim()
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
