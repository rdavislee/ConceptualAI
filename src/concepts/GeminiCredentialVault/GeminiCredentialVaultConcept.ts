import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

const PREFIX = "GeminiCredentialVault" + ".";
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

type User = ID;
type GeminiTier = "1" | "2" | "3";
type GeminiCredentialCheckResult =
  | { ok: true }
  | {
    ok: false;
    statusCode: 400 | 503;
    error: string;
  };

interface GeminiModelInfo {
  name: string;
  supportedGenerationMethods?: string[];
}

interface GeminiCredentialDoc {
  _id: User;
  ciphertext: string;
  iv: string;
  kdfSalt: string;
  kdfParams: Record<string, unknown>;
  encryptionVersion: string;
  geminiTier: GeminiTier;
  createdAt: Date;
  updatedAt: Date;
  lastVerifiedAt?: Date;
}

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

function normalizeModelName(value: string): string {
  return value.startsWith("models/") ? value : `models/${value}`;
}

function shortModelName(value: string): string {
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function sanitizeTier(tier: unknown): string {
  if (typeof tier !== "string") return "";
  return tier.trim();
}

function parseGeminiTier(tier: unknown): GeminiTier | null {
  const normalized = sanitizeTier(tier);
  if (normalized === "1" || normalized === "2" || normalized === "3") {
    return normalized;
  }
  return null;
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
    // Fall back to the raw payload text.
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
      return modelSupportsGenerateContent(model) ? "supported" : "unsupported";
    }
  }
  return "unsupported";
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

function decodeBase64(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0
      ? ""
      : "=".repeat(4 - (normalized.length % 4));
    const binary = atob(normalized + padding);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function decryptGeminiCiphertext(
  ciphertext: string,
  iv: string,
  unwrapKey: string,
): Promise<string | null> {
  const keyBytes = decodeBase64(unwrapKey.trim());
  const ivBytes = decodeBase64(iv.trim());
  const ciphertextBytes = decodeBase64(ciphertext.trim());
  if (!keyBytes || !ivBytes || !ciphertextBytes) return null;
  if (keyBytes.byteLength === 0 || ivBytes.byteLength === 0) return null;
  const rawKey = keyBytes.slice().buffer as ArrayBuffer;
  const rawIv = ivBytes.slice().buffer as ArrayBuffer;
  const rawCiphertext = ciphertextBytes.slice().buffer as ArrayBuffer;

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: rawIv },
      cryptoKey,
      rawCiphertext,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

export const geminiCredentialVaultTestables = {
  parseGeminiTier,
  probeModel: normalizeGeminiModel(GEMINI_TIER_CHECK_MODEL),
  clearGeminiCredentialCache: () => geminiCredentialCache.clear(),
};

export default class GeminiCredentialVaultConcept {
  credentials: Collection<GeminiCredentialDoc>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.credentials = this.db.collection<GeminiCredentialDoc>(
      PREFIX + "credentials",
    );
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.credentials.createIndex({ updatedAt: 1 });
    this.indexesCreated = true;
  }

  async storeCredential(
    {
      user,
      ciphertext,
      iv,
      kdfSalt,
      kdfParams,
      encryptionVersion,
      geminiTier,
    }: {
      user: User;
      ciphertext: string;
      iv: string;
      kdfSalt: string;
      kdfParams: Record<string, unknown>;
      encryptionVersion: string;
      geminiTier: string;
    },
  ): Promise<{ ok: true } | { error: string }> {
    await this.ensureIndexes();
    const parsedTier = parseGeminiTier(geminiTier);
    if (!parsedTier) {
      return { error: "Invalid Gemini tier. Allowed values are 1, 2, or 3." };
    }
    if (!ciphertext.trim() || !iv.trim() || !kdfSalt.trim()) {
      return { error: "Missing wrapped Gemini credential fields." };
    }
    if (!encryptionVersion.trim()) {
      return { error: "Missing encryptionVersion." };
    }
    if (!isObject(kdfParams) || Object.keys(kdfParams).length === 0) {
      return { error: "Invalid kdfParams." };
    }

    const now = new Date();
    const existing = await this.credentials.findOne({ _id: user });
    await this.credentials.updateOne(
      { _id: user },
      {
        $set: {
          ciphertext: ciphertext.trim(),
          iv: iv.trim(),
          kdfSalt: kdfSalt.trim(),
          kdfParams,
          encryptionVersion: encryptionVersion.trim(),
          geminiTier: parsedTier,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );

    if (!existing) {
      await this.credentials.updateOne(
        { _id: user, createdAt: { $exists: false } as never },
        { $set: { createdAt: now } },
      );
    }

    return { ok: true };
  }

  async deleteCredential(
    { user }: { user: User },
  ): Promise<{ ok: true }> {
    await this.credentials.deleteOne({ _id: user });
    return { ok: true };
  }

  async verifyGeminiCredential(
    { apiKey, geminiTier }: { apiKey: string; geminiTier: string },
  ): Promise<GeminiCredentialCheckResult> {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      return {
        ok: false,
        statusCode: 400,
        error: "Missing required header: X-Gemini-Api-Key.",
      };
    }
    const parsedTier = parseGeminiTier(geminiTier);
    if (!parsedTier) {
      return {
        ok: false,
        statusCode: 400,
        error: "Invalid Gemini tier. Allowed values are 1, 2, or 3.",
      };
    }

    const fingerprint = await fingerprintGeminiKey(trimmedKey);
    const cacheKey = `${fingerprint}:${parsedTier}:${GEMINI_TIER_CHECK_MODEL}`;
    const now = Date.now();
    const cached = geminiCredentialCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    const normalizedModel = normalizeGeminiModel(GEMINI_TIER_CHECK_MODEL);
    const modelListUrl = `${GEMINI_API_BASE}/models?key=${
      encodeURIComponent(trimmedKey)
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
      encodeURIComponent(trimmedKey)
    }`;
    let probeResp: Response;
    try {
      probeResp = await fetchWithTimeout(
        probeUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
      probeResp.status === 403 ||
      (probeResp.status === 429 && looksLikeInsufficientTier(probeMessage));
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

    return {
      ok: false,
      statusCode: 503,
      error: "Gemini tier verification is temporarily unavailable. Please retry.",
    };
  }

  async _hasCredential(
    { user }: { user: User },
  ): Promise<Array<{ hasGeminiCredential: boolean }>> {
    const doc = await this.credentials.findOne(
      { _id: user },
      { projection: { _id: 1 } },
    );
    return [{ hasGeminiCredential: !!doc }];
  }

  async _getStatus(
    { user }: { user: User },
  ): Promise<
    Array<
      | { hasGeminiCredential: false }
      | {
        hasGeminiCredential: true;
        kdfSalt: string;
        kdfParams: Record<string, unknown>;
        encryptionVersion: string;
        geminiTier: GeminiTier;
      }
    >
  > {
    const doc = await this.credentials.findOne({ _id: user });
    if (!doc) return [{ hasGeminiCredential: false }];
    return [{
      hasGeminiCredential: true,
      kdfSalt: doc.kdfSalt,
      kdfParams: doc.kdfParams,
      encryptionVersion: doc.encryptionVersion,
      geminiTier: doc.geminiTier,
    }];
  }

  async _resolveCredential(
    { user, unwrapKey }: { user: User; unwrapKey: string },
  ): Promise<Array<{ geminiKey: string; geminiTier: GeminiTier }> | [{
    error: string;
    statusCode?: number;
  }]> {
    if (!unwrapKey.trim()) {
      return [{
        error: "Missing required header: X-Gemini-Unwrap-Key.",
        statusCode: 400,
      }];
    }
    const doc = await this.credentials.findOne({ _id: user });
    if (!doc) {
      return [{ error: "Stored Gemini credential not found.", statusCode: 404 }];
    }
    const geminiKey = await decryptGeminiCiphertext(
      doc.ciphertext,
      doc.iv,
      unwrapKey,
    );
    if (!geminiKey || !geminiKey.trim()) {
      return [{ error: "Invalid Gemini unwrap key.", statusCode: 401 }];
    }
    const verification = await this.verifyGeminiCredential({
      apiKey: geminiKey,
      geminiTier: doc.geminiTier,
    });
    if (!verification.ok) {
      return [{
        error: verification.error,
        statusCode: verification.statusCode,
      }];
    }
    return [{
      geminiKey,
      geminiTier: doc.geminiTier,
    }];
  }
}
