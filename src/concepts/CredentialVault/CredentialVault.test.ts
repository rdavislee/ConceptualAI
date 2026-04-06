import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import {
  credentialVaultTestables,
} from "./CredentialVaultConcept.ts";
import CredentialVaultConcept from "./CredentialVaultConcept.ts";

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function encryptPayload(
  plaintext: string,
  unwrapKeyB64: string,
  ivB64: string,
): Promise<string> {
  const keyBytes = Uint8Array.from(
    atob(unwrapKeyB64),
    (char) => char.charCodeAt(0),
  );
  const ivBytes = Uint8Array.from(atob(ivB64), (char) => char.charCodeAt(0));
  const rawKey = keyBytes.slice().buffer as ArrayBuffer;
  const rawIv = ivBytes.slice().buffer as ArrayBuffer;
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
    new TextEncoder().encode(plaintext),
  );
  return bytesToBase64(new Uint8Array(encrypted));
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const mongoTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });

mongoTest("CredentialVault stores Gemini status metadata and existence", async () => {
  const [db, client] = await testDb();
  const vault = new CredentialVaultConcept(db);
  const user = "user-1" as ID;
  try {
    const beforeStatus = await vault._getStatus({ user, provider: "gemini" });
    assertEquals(beforeStatus, [{ hasGeminiCredential: false }]);

    const storeResult = await vault.storeCredential({
      user,
      provider: "gemini",
      ciphertext: "ciphertext-value",
      iv: "iv-value",
      redactedMetadata: { geminiTier: "2" },
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
    });
    assertEquals(storeResult, { ok: true });

    const hasCredential = await vault._hasCredential({ user, provider: "gemini" });
    assertEquals(hasCredential, [{ hasGeminiCredential: true }]);

    const status = await vault._getStatus({ user, provider: "gemini" });
    assertEquals(status, [{
      hasGeminiCredential: true,
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
      geminiTier: "2",
    }]);
  } finally {
    await client.close();
  }
});

mongoTest("CredentialVault resolves plaintext Gemini key with unwrap key", async () => {
  const [db, client] = await testDb();
  const vault = new CredentialVaultConcept(db);
  const user = "user-2" as ID;
  try {
    const unwrapKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const unwrapKey = bytesToBase64(unwrapKeyBytes);
    const iv = bytesToBase64(ivBytes);
    const ciphertext = await encryptPayload(
      "AIzaStoredGeminiKey1234567890",
      unwrapKey,
      iv,
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/models?")) {
        return jsonResponse(200, {
          models: [{
            name: credentialVaultTestables.probeModel,
            supportedGenerationMethods: ["generateContent"],
          }],
        });
      }
      if (url.includes(":generateContent?")) {
        return jsonResponse(200, { candidates: [{ content: {} }] });
      }
      return jsonResponse(500, { error: { message: "Unexpected URL" } });
    }) as typeof fetch;

    try {
      const storeResult = await vault.storeCredential({
        user,
        provider: "gemini",
        ciphertext,
        iv,
        redactedMetadata: { geminiTier: "3" },
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
      });
      assertEquals(storeResult, { ok: true });

      const resolved = await vault._resolveCredential({
        user,
        provider: "gemini",
        unwrapKey,
      });
      assertEquals(resolved, [{
        geminiKey: "AIzaStoredGeminiKey1234567890",
        geminiTier: "3",
      }]);

      const invalidResolved = await vault._resolveCredential({
        user,
        provider: "gemini",
        unwrapKey: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
      });
      assertEquals(invalidResolved, [{
        error: "Invalid Gemini unwrap key.",
        statusCode: 401,
      }]);

      const missingResolved = await vault._resolveCredential({
        user,
        provider: "gemini",
        unwrapKey: "",
      });
      assertEquals(missingResolved, [{
        error: "Missing required header: X-Gemini-Unwrap-Key.",
        statusCode: 400,
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await client.close();
  }
});

mongoTest("CredentialVault keeps one vault per user across providers", async () => {
  const [db, client] = await testDb();
  const vault = new CredentialVaultConcept(db);
  const user = "user-3" as ID;
  try {
    const geminiStore = await vault.storeCredential({
      user,
      provider: "gemini",
      ciphertext: "gemini-cipher",
      iv: "gemini-iv",
      redactedMetadata: { geminiTier: "1" },
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
    });
    assertEquals(geminiStore, { ok: true });

    const githubPayload = JSON.stringify({
      accessToken: "ghu_access_123",
      refreshToken: "ghr_refresh_123",
      login: "octocat",
      externalAccountId: "github-user-123",
      installationId: "987654",
      permissions: { administration: "write", contents: "write" },
      accessTokenExpiresAt: "2026-04-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
      tokenType: "bearer",
    });
    const unwrapKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
    const githubCiphertext = await encryptPayload(githubPayload, unwrapKey, iv);

    const githubStore = await vault.storeCredential({
      user,
      provider: "github",
      ciphertext: githubCiphertext,
      iv,
      redactedMetadata: {
        login: "octocat",
        installationId: "987654",
        permissions: { administration: "write", contents: "write" },
        accessTokenExpiresAt: "2026-04-01T00:00:00.000Z",
        refreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
        tokenType: "bearer",
      },
      externalAccountId: "github-user-123",
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
    });
    assertEquals(githubStore, { ok: true });

    assertEquals(await vault.credentials.countDocuments({}), 1);
    const storedVault = await vault.credentials.findOne({ _id: user });
    assertEquals(storedVault?.credentials.length, 2);

    const githubStatus = await vault._getStatus({ user, provider: "github" });
    assertEquals(githubStatus, [{
      hasGithubCredential: true,
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
      githubLogin: "octocat",
      externalAccountId: "github-user-123",
      githubInstallationId: "987654",
      githubPermissions: { administration: "write", contents: "write" },
      githubTokenType: "bearer",
      githubAccessTokenExpiresAt: "2026-04-01T00:00:00.000Z",
      githubRefreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
    }]);

    const linkedUser = await vault._getLinkedUser({
      provider: "github",
      externalAccountId: "github-user-123",
    });
    assertEquals(linkedUser, [{ user }]);
  } finally {
    await client.close();
  }
});

mongoTest("CredentialVault allows Gemini credentials for multiple users", async () => {
  const [db, client] = await testDb();
  const vault = new CredentialVaultConcept(db);
  const userA = "user-gemini-a" as ID;
  const userB = "user-gemini-b" as ID;
  try {
    const firstStore = await vault.storeCredential({
      user: userA,
      provider: "gemini",
      ciphertext: "gemini-cipher-a",
      iv: "gemini-iv-a",
      redactedMetadata: { geminiTier: "1" },
      kdfSalt: "salt-a",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
    });
    assertEquals(firstStore, { ok: true });

    const secondStore = await vault.storeCredential({
      user: userB,
      provider: "gemini",
      ciphertext: "gemini-cipher-b",
      iv: "gemini-iv-b",
      redactedMetadata: { geminiTier: "1" },
      kdfSalt: "salt-b",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
    });
    assertEquals(secondStore, { ok: true });

    const firstVault = await vault.credentials.findOne({ _id: userA });
    const secondVault = await vault.credentials.findOne({ _id: userB });
    assertEquals(firstVault?.credentials[0]?.externalAccountId, undefined);
    assertEquals(secondVault?.credentials[0]?.externalAccountId, undefined);
  } finally {
    await client.close();
  }
});

mongoTest("CredentialVault deleteCredential removes one provider without deleting others", async () => {
  const [db, client] = await testDb();
  const vault = new CredentialVaultConcept(db);
  const user = "user-4" as ID;
  try {
    await vault.storeCredential({
      user,
      provider: "gemini",
      ciphertext: "gemini-cipher",
      iv: "gemini-iv",
      redactedMetadata: { geminiTier: "1" },
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
    });
    await vault.storeCredential({
      user,
      provider: "github",
      ciphertext: "github-cipher",
      iv: "github-iv",
      redactedMetadata: {
        login: "octocat",
        installationId: "123",
        permissions: { contents: "write" },
      },
      externalAccountId: "github-user-234",
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
    });

    const deleteResult = await vault.deleteCredential({
      user,
      provider: "gemini",
    });
    assertEquals(deleteResult, { ok: true });

    assertEquals(
      await vault._getStatus({ user, provider: "gemini" }),
      [{ hasGeminiCredential: false }],
    );
    assertEquals(
      await vault._hasCredential({ user, provider: "github" }),
      [{ hasGithubCredential: true }],
    );
  } finally {
    await client.close();
  }
});

mongoTest("CredentialVault refreshGithubCredential re-encrypts refreshed GitHub token", async () => {
  const [db, client] = await testDb();
  const vault = new CredentialVaultConcept(db);
  const user = "user-5" as ID;
  const previousClientId = Deno.env.get("GITHUB_APP_CLIENT_ID");
  const previousClientSecret = Deno.env.get("GITHUB_APP_CLIENT_SECRET");
  try {
    Deno.env.set("GITHUB_APP_CLIENT_ID", "github-client-id");
    Deno.env.set("GITHUB_APP_CLIENT_SECRET", "github-client-secret");

    const unwrapKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
    const ciphertext = await encryptPayload(JSON.stringify({
      accessToken: "ghu_access_old",
      refreshToken: "ghr_refresh_old",
      login: "octocat",
      externalAccountId: "github-user-345",
      installationId: "654321",
      permissions: { administration: "write", contents: "write" },
      accessTokenExpiresAt: "2026-04-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
      tokenType: "bearer",
    }), unwrapKey, iv);

    await vault.storeCredential({
      user,
      provider: "github",
      ciphertext,
      iv,
      redactedMetadata: {
        login: "octocat",
        installationId: "654321",
        permissions: { administration: "write", contents: "write" },
        accessTokenExpiresAt: "2026-04-01T00:00:00.000Z",
        refreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
        tokenType: "bearer",
      },
      externalAccountId: "github-user-345",
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url === "https://github.com/login/oauth/access_token") {
        return jsonResponse(200, {
          access_token: "ghu_access_new",
          refresh_token: "ghr_refresh_new",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token_expires_in: 7200,
        });
      }
      return jsonResponse(500, { error: "Unexpected URL" });
    }) as typeof fetch;

    try {
      const refreshResult = await vault.refreshGithubCredential({
        user,
        provider: "github",
        unwrapKey,
      });
      assertEquals(refreshResult, { ok: true });

      const resolved = await vault._resolveCredential({
        user,
        provider: "github",
        unwrapKey,
      });
      assertEquals((resolved[0] as Record<string, unknown>).accessToken, "ghu_access_new");
      assertEquals((resolved[0] as Record<string, unknown>).refreshToken, "ghr_refresh_new");

      const status = await vault._getStatus({ user, provider: "github" });
      const statusRecord = status[0] as Record<string, unknown>;
      assertEquals(statusRecord.hasGithubCredential, true);
      assertEquals(statusRecord.githubLogin, "octocat");
      assertEquals(statusRecord.githubTokenType, "bearer");
      assertEquals(
        typeof statusRecord.githubAccessTokenExpiresAt,
        "string",
      );
      assertEquals(
        typeof statusRecord.githubRefreshTokenExpiresAt,
        "string",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (previousClientId === undefined) {
      Deno.env.delete("GITHUB_APP_CLIENT_ID");
    } else {
      Deno.env.set("GITHUB_APP_CLIENT_ID", previousClientId);
    }
    if (previousClientSecret === undefined) {
      Deno.env.delete("GITHUB_APP_CLIENT_SECRET");
    } else {
      Deno.env.set("GITHUB_APP_CLIENT_SECRET", previousClientSecret);
    }
    await client.close();
  }
});
