import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

const PREFIX = "CredentialVault.";
const LEGACY_GEMINI_PREFIX = "GeminiCredentialVault.";
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
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";

type User = ID;
type Provider = string;
type GeminiTier = "1" | "2" | "3";
type CredentialStoreResult = { ok: true } | { error: string };
type CredentialDeleteResult = { ok: true };
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

interface LegacyGeminiCredentialDoc {
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

interface CredentialEntry {
  provider: Provider;
  ciphertext: string;
  iv: string;
  redactedMetadata: Record<string, unknown>;
  externalAccountId?: string;
  createdAt: Date;
  updatedAt: Date;
  lastVerifiedAt?: Date;
}

interface VaultDoc {
  _id: User;
  kdfSalt: string;
  kdfParams: Record<string, unknown>;
  encryptionVersion: string;
  credentials: CredentialEntry[];
  createdAt: Date;
  updatedAt: Date;
}

interface GitHubCredentialPayload {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  login?: string;
  externalAccountId?: string;
  installationId?: string;
  permissions?: Record<string, unknown>;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}

const geminiCredentialCache = new Map<
  string,
  { expiresAt: number; result: GeminiCredentialCheckResult }
>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProvider(provider: unknown): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
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

function encodeBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

async function decryptWithUnwrapKey(
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

async function encryptWithUnwrapKey(
  plaintext: string,
  unwrapKey: string,
): Promise<{ ciphertext: string; iv: string } | null> {
  const keyBytes = decodeBase64(unwrapKey.trim());
  if (!keyBytes || keyBytes.byteLength === 0) return null;
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const rawKey = keyBytes.slice().buffer as ArrayBuffer;
  const rawIv = ivBytes.slice().buffer as ArrayBuffer;
  const payloadBytes = new TextEncoder().encode(plaintext);
  const rawPayload = payloadBytes.slice().buffer as ArrayBuffer;

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: rawIv },
      cryptoKey,
      rawPayload,
    );
    return {
      ciphertext: encodeBase64(new Uint8Array(encrypted)),
      iv: encodeBase64(ivBytes),
    };
  } catch {
    return null;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasCredentialKeyName(provider: string): string {
  if (provider === "gemini") return "hasGeminiCredential";
  if (provider === "github") return "hasGithubCredential";
  return "hasCredential";
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractRecord(
  value: unknown,
): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function parseDateInput(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return "";
}

function extractGitHubPayload(
  decrypted: string,
): GitHubCredentialPayload | null {
  try {
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    if (!isObject(parsed)) return null;
    const accessToken = normalizeString(parsed.accessToken);
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: normalizeString(parsed.refreshToken) || undefined,
      tokenType: normalizeString(parsed.tokenType) || undefined,
      login: normalizeString(parsed.login) || undefined,
      externalAccountId: normalizeString(parsed.externalAccountId) || undefined,
      installationId: normalizeString(parsed.installationId) || undefined,
      permissions: extractRecord(parsed.permissions) ?? undefined,
      accessTokenExpiresAt:
        parseDateInput(parsed.accessTokenExpiresAt) || undefined,
      refreshTokenExpiresAt:
        parseDateInput(parsed.refreshTokenExpiresAt) || undefined,
    };
  } catch {
    return null;
  }
}

function findCredentialEntry(
  vault: VaultDoc,
  provider: string,
): CredentialEntry | null {
  return vault.credentials.find((entry) => entry.provider === provider) ?? null;
}

function buildGeminiStatus(
  vault: VaultDoc,
  entry: CredentialEntry,
): Array<
  | { hasGeminiCredential: false }
  | {
    hasGeminiCredential: true;
    kdfSalt: string;
    kdfParams: Record<string, unknown>;
    encryptionVersion: string;
    geminiTier: GeminiTier;
  }
> {
  const tier = parseGeminiTier(entry.redactedMetadata.geminiTier);
  if (!tier) {
    return [{ hasGeminiCredential: false }];
  }
  return [{
    hasGeminiCredential: true,
    kdfSalt: vault.kdfSalt,
    kdfParams: vault.kdfParams,
    encryptionVersion: vault.encryptionVersion,
    geminiTier: tier,
  }];
}

function buildGitHubStatus(
  vault: VaultDoc,
  entry: CredentialEntry,
): Array<
  | { hasGithubCredential: false }
  | {
    hasGithubCredential: true;
    kdfSalt: string;
    kdfParams: Record<string, unknown>;
    encryptionVersion: string;
    githubLogin: string;
    externalAccountId: string;
    githubInstallationId: string;
    githubPermissions: Record<string, unknown>;
    githubTokenType: string;
    githubAccessTokenExpiresAt: string;
    githubRefreshTokenExpiresAt: string;
  }
> {
  const metadata = entry.redactedMetadata;
  return [{
    hasGithubCredential: true,
    kdfSalt: vault.kdfSalt,
    kdfParams: vault.kdfParams,
    encryptionVersion: vault.encryptionVersion,
    githubLogin: normalizeString(metadata.login),
    externalAccountId: normalizeString(entry.externalAccountId),
    githubInstallationId: normalizeString(metadata.installationId),
    githubPermissions: extractRecord(metadata.permissions) ?? {},
    githubTokenType: normalizeString(metadata.tokenType),
    githubAccessTokenExpiresAt: parseDateInput(metadata.accessTokenExpiresAt),
    githubRefreshTokenExpiresAt: parseDateInput(metadata.refreshTokenExpiresAt),
  }];
}

function buildMissingCredentialResult(provider: string): Array<Record<string, unknown>> {
  return [{ [hasCredentialKeyName(provider)]: false }];
}

function geminiResolveMissingError() {
  return {
    error: "Stored Gemini credential not found.",
    statusCode: 404,
  };
}

function geminiResolveMissingUnwrapKeyError() {
  return {
    error: "Missing required header: X-Gemini-Unwrap-Key.",
    statusCode: 400,
  };
}

function geminiResolveInvalidUnwrapKeyError() {
  return {
    error: "Invalid Gemini unwrap key.",
    statusCode: 401,
  };
}

function githubResolveMissingError() {
  return {
    error: "Stored GitHub credential not found.",
    statusCode: 404,
  };
}

function githubResolveMissingUnwrapKeyError() {
  return {
    error: "Missing required unwrap key.",
    statusCode: 400,
  };
}

function githubResolveInvalidUnwrapKeyError() {
  return {
    error: "Invalid credential unwrap key.",
    statusCode: 401,
  };
}

function extractGitHubOauthError(payloadText: string): string {
  const trimmed = payloadText.trim();
  if (!trimmed) return "Failed to refresh GitHub user access token.";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const description = normalizeString(parsed.error_description);
    const error = normalizeString(parsed.error);
    if (description) return description;
    if (error) return error;
  } catch {
    // Ignore JSON parse errors and fall back to raw text.
  }
  return trimmed.slice(0, 500);
}

export const credentialVaultTestables = {
  parseGeminiTier,
  probeModel: normalizeGeminiModel(GEMINI_TIER_CHECK_MODEL),
  clearGeminiCredentialCache: () => geminiCredentialCache.clear(),
};

export default class CredentialVaultConcept {
  credentials: Collection<VaultDoc>;
  legacyGeminiCredentials: Collection<LegacyGeminiCredentialDoc>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.credentials = this.db.collection<VaultDoc>(PREFIX + "credentials");
    this.legacyGeminiCredentials = this.db.collection<LegacyGeminiCredentialDoc>(
      LEGACY_GEMINI_PREFIX + "credentials",
    );
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.credentials.createIndex({ updatedAt: 1 });
    await this.credentials.createIndex(
      { _id: 1, "credentials.provider": 1 },
      { unique: true },
    );
    await this.credentials.createIndex(
      { "credentials.externalAccountId": 1 },
      { unique: true, sparse: true },
    );
    this.indexesCreated = true;
  }

  private async loadVault(user: User): Promise<VaultDoc | null> {
    const existing = await this.credentials.findOne({ _id: user });
    if (existing) return existing;
    return await this.migrateLegacyGeminiCredential(user);
  }

  private async migrateLegacyGeminiCredential(user: User): Promise<VaultDoc | null> {
    const legacy = await this.legacyGeminiCredentials.findOne({ _id: user });
    if (!legacy) return null;

    const createdAt = legacy.createdAt instanceof Date
      ? legacy.createdAt
      : new Date(legacy.createdAt);
    const updatedAt = legacy.updatedAt instanceof Date
      ? legacy.updatedAt
      : new Date(legacy.updatedAt);
    const migratedDoc: VaultDoc = {
      _id: user,
      kdfSalt: legacy.kdfSalt,
      kdfParams: legacy.kdfParams,
      encryptionVersion: legacy.encryptionVersion,
      credentials: [{
        provider: "gemini",
        ciphertext: legacy.ciphertext,
        iv: legacy.iv,
        redactedMetadata: { geminiTier: legacy.geminiTier },
        createdAt,
        updatedAt,
        lastVerifiedAt: legacy.lastVerifiedAt,
      }],
      createdAt,
      updatedAt,
    };

    try {
      await this.credentials.insertOne(migratedDoc);
      await this.legacyGeminiCredentials.deleteOne({ _id: user });
      return migratedDoc;
    } catch {
      return await this.credentials.findOne({ _id: user });
    }
  }

  private async upsertVault(
    vault: VaultDoc,
  ): Promise<void> {
    await this.credentials.updateOne(
      { _id: vault._id },
      {
        $set: {
          kdfSalt: vault.kdfSalt,
          kdfParams: vault.kdfParams,
          encryptionVersion: vault.encryptionVersion,
          credentials: vault.credentials,
          updatedAt: vault.updatedAt,
        },
        $setOnInsert: {
          createdAt: vault.createdAt,
        },
      },
      { upsert: true },
    );
  }

  async storeCredential(
    {
      user,
      provider,
      ciphertext,
      iv,
      redactedMetadata,
      externalAccountId,
      kdfSalt,
      kdfParams,
      encryptionVersion,
    }: {
      user: User;
      provider: string;
      ciphertext: string;
      iv: string;
      redactedMetadata: Record<string, unknown>;
      externalAccountId?: string;
      kdfSalt?: string;
      kdfParams?: Record<string, unknown>;
      encryptionVersion?: string;
    },
  ): Promise<CredentialStoreResult> {
    await this.ensureIndexes();
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) {
      return { error: "Missing credential provider." };
    }
    if (!ciphertext.trim() || !iv.trim()) {
      return { error: "Missing wrapped credential fields." };
    }
    if (!isObject(redactedMetadata)) {
      return { error: "Invalid redactedMetadata." };
    }

    if (normalizedProvider === "gemini") {
      const parsedTier = parseGeminiTier(redactedMetadata.geminiTier);
      if (!parsedTier) {
        return { error: "Invalid Gemini tier. Allowed values are 1, 2, or 3." };
      }
    }

    const trimmedExternalAccountId = normalizeString(externalAccountId);
    if (trimmedExternalAccountId) {
      const linkedVault = await this.credentials.findOne({
        credentials: {
          $elemMatch: {
            provider: normalizedProvider,
            externalAccountId: trimmedExternalAccountId,
          },
        },
      });
      if (linkedVault && linkedVault._id !== user) {
        return { error: "Credential is already linked to another user." };
      }
    }

    const now = new Date();
    const existingVault = await this.loadVault(user);
    const providedKdfSalt = normalizeString(kdfSalt);
    const providedEncryptionVersion = normalizeString(encryptionVersion);
    const providedKdfParams = isObject(kdfParams) ? kdfParams : null;

    let nextVault: VaultDoc;
    if (existingVault) {
      if (
        providedKdfSalt &&
        existingVault.kdfSalt !== providedKdfSalt
      ) {
        return { error: "Vault KDF metadata does not match existing credential vault." };
      }
      if (
        providedEncryptionVersion &&
        existingVault.encryptionVersion !== providedEncryptionVersion
      ) {
        return {
          error: "Vault encryption version does not match existing credential vault.",
        };
      }
      if (
        providedKdfParams &&
        !deepEqual(existingVault.kdfParams, providedKdfParams)
      ) {
        return { error: "Vault KDF metadata does not match existing credential vault." };
      }
      const existingEntry = findCredentialEntry(existingVault, normalizedProvider);
      const nextEntry: CredentialEntry = {
        provider: normalizedProvider,
        ciphertext: ciphertext.trim(),
        iv: iv.trim(),
        redactedMetadata: { ...redactedMetadata },
        externalAccountId: trimmedExternalAccountId || undefined,
        createdAt: existingEntry?.createdAt ?? now,
        updatedAt: now,
        lastVerifiedAt: existingEntry?.lastVerifiedAt,
      };
      nextVault = {
        ...existingVault,
        updatedAt: now,
        credentials: [
          ...existingVault.credentials.filter((entry) =>
            entry.provider !== normalizedProvider
          ),
          nextEntry,
        ],
      };
    } else {
      if (!providedKdfSalt) {
        return { error: "Missing kdfSalt." };
      }
      if (!providedKdfParams || Object.keys(providedKdfParams).length === 0) {
        return { error: "Invalid kdfParams." };
      }
      if (!providedEncryptionVersion) {
        return { error: "Missing encryptionVersion." };
      }
      nextVault = {
        _id: user,
        kdfSalt: providedKdfSalt,
        kdfParams: providedKdfParams,
        encryptionVersion: providedEncryptionVersion,
        createdAt: now,
        updatedAt: now,
        credentials: [{
          provider: normalizedProvider,
          ciphertext: ciphertext.trim(),
          iv: iv.trim(),
          redactedMetadata: { ...redactedMetadata },
          externalAccountId: trimmedExternalAccountId || undefined,
          createdAt: now,
          updatedAt: now,
        }],
      };
    }

    await this.upsertVault(nextVault);
    if (normalizedProvider === "gemini") {
      await this.legacyGeminiCredentials.deleteOne({ _id: user });
    }
    return { ok: true };
  }

  async deleteCredential(
    { user, provider }: { user: User; provider: string },
  ): Promise<CredentialDeleteResult> {
    const normalizedProvider = normalizeProvider(provider);
    const vault = await this.loadVault(user);
    if (!vault) {
      await this.legacyGeminiCredentials.deleteOne({ _id: user });
      return { ok: true };
    }

    const remaining = vault.credentials.filter((entry) =>
      entry.provider !== normalizedProvider
    );
    if (remaining.length === 0) {
      await this.credentials.deleteOne({ _id: user });
      await this.legacyGeminiCredentials.deleteOne({ _id: user });
      return { ok: true };
    }

    await this.credentials.updateOne(
      { _id: user },
      {
        $set: {
          credentials: remaining,
          updatedAt: new Date(),
        },
      },
    );
    return { ok: true };
  }

  async deleteByUser(
    { user }: { user: User },
  ): Promise<CredentialDeleteResult> {
    await this.credentials.deleteOne({ _id: user });
    await this.legacyGeminiCredentials.deleteOne({ _id: user });
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
    { user, provider }: { user: User; provider: string },
  ): Promise<Array<Record<string, unknown>>> {
    const normalizedProvider = normalizeProvider(provider);
    const vault = await this.loadVault(user);
    const hasCredential = !!vault &&
      !!findCredentialEntry(vault, normalizedProvider);
    return [{ [hasCredentialKeyName(normalizedProvider)]: hasCredential }];
  }

  async _getStatus(
    { user, provider }: { user: User; provider: string },
  ): Promise<Array<Record<string, unknown>>> {
    const normalizedProvider = normalizeProvider(provider);
    const vault = await this.loadVault(user);
    if (!vault) return buildMissingCredentialResult(normalizedProvider);

    const entry = findCredentialEntry(vault, normalizedProvider);
    if (!entry) return buildMissingCredentialResult(normalizedProvider);

    if (normalizedProvider === "gemini") {
      return buildGeminiStatus(vault, entry);
    }
    if (normalizedProvider === "github") {
      return buildGitHubStatus(vault, entry);
    }

    return [{
      hasCredential: true,
      kdfSalt: vault.kdfSalt,
      kdfParams: vault.kdfParams,
      encryptionVersion: vault.encryptionVersion,
      redactedMetadata: entry.redactedMetadata,
      externalAccountId: entry.externalAccountId ?? "",
    }];
  }

  async _resolveCredential(
    {
      user,
      provider,
      unwrapKey,
    }: {
      user: User;
      provider: string;
      unwrapKey: string;
    },
  ): Promise<Array<Record<string, unknown>>> {
    const normalizedProvider = normalizeProvider(provider);
    if (!unwrapKey.trim()) {
      return [normalizedProvider === "gemini"
        ? geminiResolveMissingUnwrapKeyError()
        : githubResolveMissingUnwrapKeyError()];
    }

    const vault = await this.loadVault(user);
    if (!vault) {
      return [normalizedProvider === "gemini"
        ? geminiResolveMissingError()
        : githubResolveMissingError()];
    }

    const entry = findCredentialEntry(vault, normalizedProvider);
    if (!entry) {
      return [normalizedProvider === "gemini"
        ? geminiResolveMissingError()
        : githubResolveMissingError()];
    }

    const decrypted = await decryptWithUnwrapKey(
      entry.ciphertext,
      entry.iv,
      unwrapKey,
    );
    if (!decrypted || !decrypted.trim()) {
      return [normalizedProvider === "gemini"
        ? geminiResolveInvalidUnwrapKeyError()
        : githubResolveInvalidUnwrapKeyError()];
    }

    if (normalizedProvider === "gemini") {
      const geminiTier = parseGeminiTier(entry.redactedMetadata.geminiTier);
      if (!geminiTier) {
        return [geminiResolveMissingError()];
      }
      const verification = await this.verifyGeminiCredential({
        apiKey: decrypted,
        geminiTier,
      });
      if (!verification.ok) {
        return [{
          error: verification.error,
          statusCode: verification.statusCode,
        }];
      }
      return [{
        geminiKey: decrypted,
        geminiTier,
      }];
    }

    if (normalizedProvider === "github") {
      const payload = extractGitHubPayload(decrypted);
      if (!payload) {
        return [githubResolveInvalidUnwrapKeyError()];
      }
      return [{
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken ?? "",
        tokenType: payload.tokenType ?? "",
        login: payload.login ?? normalizeString(entry.redactedMetadata.login),
        externalAccountId: payload.externalAccountId ??
          normalizeString(entry.externalAccountId),
        installationId: payload.installationId ??
          normalizeString(entry.redactedMetadata.installationId),
        permissions: payload.permissions ??
          (extractRecord(entry.redactedMetadata.permissions) ?? {}),
        accessTokenExpiresAt: payload.accessTokenExpiresAt ??
          parseDateInput(entry.redactedMetadata.accessTokenExpiresAt),
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt ??
          parseDateInput(entry.redactedMetadata.refreshTokenExpiresAt),
      }];
    }

    return [{
      ciphertext: decrypted,
      redactedMetadata: entry.redactedMetadata,
      externalAccountId: entry.externalAccountId ?? "",
    }];
  }

  async _getLinkedUser(
    { provider, externalAccountId }: { provider: string; externalAccountId: string },
  ): Promise<Array<{ user: User }>> {
    const normalizedProvider = normalizeProvider(provider);
    const trimmedExternalAccountId = normalizeString(externalAccountId);
    if (!normalizedProvider || !trimmedExternalAccountId) return [];
    const doc = await this.credentials.findOne({
      credentials: {
        $elemMatch: {
          provider: normalizedProvider,
          externalAccountId: trimmedExternalAccountId,
        },
      },
    });
    if (!doc) return [];
    return [{ user: doc._id }];
  }

  async refreshGithubCredential(
    { user, provider, unwrapKey }: { user: User; provider: string; unwrapKey: string },
  ): Promise<CredentialStoreResult> {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider !== "github") {
      return { error: "GitHub refresh is only supported for provider \"github\"." };
    }

    const resolvedRows = await this._resolveCredential({
      user,
      provider: normalizedProvider,
      unwrapKey,
    });
    const resolved = resolvedRows[0];
    if (!resolved || "error" in resolved) {
      return { error: String((resolved as any)?.error ?? "Stored GitHub credential not found.") };
    }

    const refreshToken = normalizeString(resolved.refreshToken);
    if (!refreshToken) {
      return { error: "GitHub refresh token not found." };
    }

    const clientId = normalizeString(Deno.env.get("GITHUB_APP_CLIENT_ID"));
    const clientSecret = normalizeString(
      Deno.env.get("GITHUB_APP_CLIENT_SECRET"),
    );
    if (!clientId || !clientSecret) {
      return { error: "GitHub App OAuth credentials are not configured." };
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        GITHUB_OAUTH_TOKEN_URL,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }).toString(),
        },
        30000,
      );
    } catch {
      return { error: "Unable to refresh GitHub access token right now." };
    }

    const payloadText = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(payloadText) as Record<string, unknown>;
    } catch {
      return { error: extractGitHubOauthError(payloadText) };
    }

    if (!response.ok) {
      return { error: extractGitHubOauthError(payloadText) };
    }

    const accessToken = normalizeString(payload.access_token);
    if (!accessToken) {
      return { error: "GitHub refresh response did not include an access token." };
    }

    const nextRefreshToken = normalizeString(payload.refresh_token) || refreshToken;
    const tokenType = normalizeString(payload.token_type) || "bearer";
    const accessTokenExpiresAt = typeof payload.expires_in === "number"
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : "";
    const refreshTokenExpiresAt =
      typeof payload.refresh_token_expires_in === "number"
        ? new Date(Date.now() + payload.refresh_token_expires_in * 1000)
          .toISOString()
        : "";

    const vault = await this.loadVault(user);
    if (!vault) {
      return { error: "Stored GitHub credential not found." };
    }
    const entry = findCredentialEntry(vault, normalizedProvider);
    if (!entry) {
      return { error: "Stored GitHub credential not found." };
    }

    const decrypted = await decryptWithUnwrapKey(
      entry.ciphertext,
      entry.iv,
      unwrapKey,
    );
    if (!decrypted || !decrypted.trim()) {
      return { error: "Invalid credential unwrap key." };
    }
    const currentPayload = extractGitHubPayload(decrypted);
    if (!currentPayload) {
      return { error: "Stored GitHub credential is invalid." };
    }

    const nextPayload: GitHubCredentialPayload = {
      ...currentPayload,
      accessToken,
      refreshToken: nextRefreshToken,
      tokenType,
      accessTokenExpiresAt: accessTokenExpiresAt || undefined,
      refreshTokenExpiresAt: refreshTokenExpiresAt || undefined,
    };
    const encrypted = await encryptWithUnwrapKey(
      JSON.stringify(nextPayload),
      unwrapKey,
    );
    if (!encrypted) {
      return { error: "Failed to re-encrypt refreshed GitHub credential." };
    }

    const now = new Date();
    const nextCredentials = vault.credentials.map((candidate) => {
      if (candidate.provider !== normalizedProvider) return candidate;
      return {
        ...candidate,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        updatedAt: now,
        redactedMetadata: {
          ...candidate.redactedMetadata,
          login: nextPayload.login ?? normalizeString(candidate.redactedMetadata.login),
          installationId: nextPayload.installationId ??
            normalizeString(candidate.redactedMetadata.installationId),
          permissions: nextPayload.permissions ??
            (extractRecord(candidate.redactedMetadata.permissions) ?? {}),
          tokenType,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
        },
      };
    });

    await this.credentials.updateOne(
      { _id: user },
      {
        $set: {
          credentials: nextCredentials,
          updatedAt: now,
        },
      },
    );
    return { ok: true };
  }
}
