import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import { testDb } from "@utils/database.ts";

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
  const rawPayload = new TextEncoder().encode(plaintext).slice().buffer as ArrayBuffer;
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
  return bytesToBase64(new Uint8Array(encrypted));
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

function setGitHubEnv(): Record<string, string | undefined> {
  const previous = {
    GITHUB_APP_CLIENT_ID: Deno.env.get("GITHUB_APP_CLIENT_ID"),
    GITHUB_APP_CLIENT_SECRET: Deno.env.get("GITHUB_APP_CLIENT_SECRET"),
    GITHUB_APP_CALLBACK_URL: Deno.env.get("GITHUB_APP_CALLBACK_URL"),
    CREDENTIAL_VAULT_ENCRYPTION_KEY:
      Deno.env.get("CREDENTIAL_VAULT_ENCRYPTION_KEY"),
  };
  Deno.env.set("GITHUB_APP_CLIENT_ID", "github-client-id");
  Deno.env.set("GITHUB_APP_CLIENT_SECRET", "github-client-secret");
  Deno.env.set(
    "GITHUB_APP_CALLBACK_URL",
    "https://api.example.com/api/auth/github/callback",
  );
  Deno.env.set(
    "CREDENTIAL_VAULT_ENCRYPTION_KEY",
    "credential-vault-secret-which-is-long-enough",
  );
  return previous;
}

function restoreGitHubEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

async function initializeSyncConcepts() {
  const [db, client] = await testDb();
  const Requesting = concepts.Requesting as any;
  const Authenticating = concepts.Authenticating as any;
  const Sessioning = concepts.Sessioning as any;
  const CredentialVault = concepts.CredentialVault as any;

  Requesting.requests = db.collection("Requesting.requests");
  Requesting.pending = new Map();
  Authenticating.users = db.collection("Authenticating.users");
  Sessioning.sessions = db.collection("Sessioning.sessions");
  CredentialVault.credentials = db.collection("CredentialVault.credentials");
  CredentialVault.legacyGeminiCredentials = db.collection(
    "GeminiCredentialVault.credentials",
  );

  Engine.logging = Logging.OFF;
  Engine.register(syncs);

  return {
    db,
    client,
    Requesting,
    Authenticating,
    Sessioning,
    CredentialVault,
  };
}

Deno.test({
  name: "Sync: GitHub link start returns auth URL and callback rejects invalid state",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = setGitHubEnv();
    const { client, Requesting, Authenticating, Sessioning } =
      await initializeSyncConcepts();
    try {
      const { user } = await Authenticating.register({
        email: "github-link-start@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });

      const { request: startRequest } = await Requesting.request({
        path: "/me/github/link/start",
        method: "POST",
        accessToken,
        frontendOrigin: "https://frontend.example.com",
        returnPath: "/projects/project-123",
      });
      const [startResponseFrame] = await Requesting._awaitResponse({
        request: startRequest,
      });
      const startResponse = startResponseFrame.response as any;
      assertStringIncludes(
        startResponse.authorizationUrl,
        "https://github.com/login/oauth/authorize",
      );
      const authUrl = new URL(startResponse.authorizationUrl);
      assertStringIncludes(
        authUrl.searchParams.get("redirect_uri") || "",
        "https://api.example.com/api/auth/github/callback",
      );
      assertEquals(authUrl.searchParams.has("state"), true);

      const { request: callbackRequest } = await Requesting.request({
        path: "/auth/github/callback",
        method: "GET",
        code: "bad-code",
        state: "invalid.state.token",
      });
      const [callbackResponseFrame] = await Requesting._awaitResponse({
        request: callbackRequest,
      });
      const callbackResponse = callbackResponseFrame.response as any;
      assertEquals(callbackResponse.statusCode, 400);
      const html = await streamToString(callbackResponse.stream);
      assertStringIncludes(html, "GitHub callback state mismatch or expiration.");
    } finally {
      await client.close();
      restoreGitHubEnv(previousEnv);
    }
  },
});

Deno.test({
  name: "Sync: GitHub callback returns frontend bridge payload on success",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = setGitHubEnv();
    const { client, Requesting, Authenticating, Sessioning } =
      await initializeSyncConcepts();
    const originalFetch = globalThis.fetch;
    try {
      const { user } = await Authenticating.register({
        email: "github-callback@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });

      const { request: startRequest } = await Requesting.request({
        path: "/me/github/link/start",
        method: "POST",
        accessToken,
        frontendOrigin: "https://frontend.example.com",
        returnPath: "/settings/integrations",
      });
      const [startResponseFrame] = await Requesting._awaitResponse({
        request: startRequest,
      });
      const startResponse = startResponseFrame.response as any;
      const state = new URL(startResponse.authorizationUrl).searchParams.get("state");

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({
            access_token: "ghu_access_123",
            refresh_token: "ghr_refresh_123",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token_expires_in: 7200,
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({
            login: "octocat",
            id: 12345,
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://api.github.com/user/installations") {
          return new Response(JSON.stringify({
            installations: [{
              id: 6789,
              account: { login: "octocat", type: "User" },
              permissions: { administration: "write", contents: "write" },
            }],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ message: "Unexpected URL" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const { request: callbackRequest } = await Requesting.request({
        path: "/auth/github/callback",
        method: "GET",
        code: "good-code",
        state,
      });
      const [callbackResponseFrame] = await Requesting._awaitResponse({
        request: callbackRequest,
      });
      const callbackResponse = callbackResponseFrame.response as any;
      assertEquals(callbackResponse.statusCode, 200);
      const html = await streamToString(callbackResponse.stream);
      assertStringIncludes(html, "conceptualai:github-link-callback");
      assertStringIncludes(html, "ghu_access_123");
      assertStringIncludes(html, "octocat");
      assertStringIncludes(html, "/settings/integrations");
    } finally {
      globalThis.fetch = originalFetch;
      await client.close();
      restoreGitHubEnv(previousEnv);
    }
  },
});

Deno.test({
  name: "Sync: GitHub link complete, get status, and unlink flow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = setGitHubEnv();
    const { client, Requesting, Authenticating, Sessioning } =
      await initializeSyncConcepts();
    try {
      const { user } = await Authenticating.register({
        email: "github-link-complete@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });

      const unwrapKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
      const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
      const ciphertext = await encryptPayload(JSON.stringify({
        accessToken: "ghu_access_123",
        refreshToken: "ghr_refresh_123",
        tokenType: "bearer",
        login: "octocat",
        externalAccountId: "12345",
        installationId: "6789",
        permissions: { administration: "write", contents: "write" },
        accessTokenExpiresAt: "2026-04-01T00:00:00.000Z",
        refreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
      }), unwrapKey, iv);

      const { request: completeRequest } = await Requesting.request({
        path: "/me/github/link/complete",
        method: "POST",
        accessToken,
        accountPassword: "password123",
        ciphertext,
        iv,
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
        externalAccountId: "12345",
        githubLogin: "octocat",
        installationId: "6789",
        permissions: { administration: "write", contents: "write" },
        tokenType: "bearer",
        accessTokenExpiresAt: "2026-04-01T00:00:00.000Z",
        refreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
      });
      const [completeResponseFrame] = await Requesting._awaitResponse({
        request: completeRequest,
      });
      const completeResponse = completeResponseFrame.response as any;
      assertEquals(completeResponse.hasGithubCredential, true);
      assertEquals(completeResponse.githubLogin, "octocat");
      assertEquals(completeResponse.externalAccountId, "12345");
      assertEquals(completeResponse.kdfSalt, "salt-value");

      const { request: statusRequest } = await Requesting.request({
        path: "/me/github",
        method: "GET",
        accessToken,
      });
      const [statusResponseFrame] = await Requesting._awaitResponse({
        request: statusRequest,
      });
      const statusResponse = statusResponseFrame.response as any;
      assertEquals(statusResponse.hasGithubCredential, true);
      assertEquals(statusResponse.githubLogin, "octocat");

      const { request: unlinkRequest } = await Requesting.request({
        path: "/me/github",
        method: "DELETE",
        accessToken,
      });
      const [unlinkResponseFrame] = await Requesting._awaitResponse({
        request: unlinkRequest,
      });
      assertEquals((unlinkResponseFrame.response as any).ok, true);

      const { request: finalStatusRequest } = await Requesting.request({
        path: "/me/github",
        method: "GET",
        accessToken,
      });
      const [finalStatusFrame] = await Requesting._awaitResponse({
        request: finalStatusRequest,
      });
      assertEquals(
        (finalStatusFrame.response as any).hasGithubCredential,
        false,
      );
    } finally {
      await client.close();
      restoreGitHubEnv(previousEnv);
    }
  },
});

Deno.test({
  name: "Sync: GitHub link complete rejects bad password and duplicate external account",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = setGitHubEnv();
    const { client, Requesting, Authenticating, Sessioning } =
      await initializeSyncConcepts();
    try {
      const first = await Authenticating.register({
        email: "github-dup-1@example.com",
        password: "password123",
      });
      const second = await Authenticating.register({
        email: "github-dup-2@example.com",
        password: "password123",
      });
      const firstAccess = await Sessioning.create({ user: first.user });
      const secondAccess = await Sessioning.create({ user: second.user });

      const unwrapKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
      const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
      const ciphertext = await encryptPayload(JSON.stringify({
        accessToken: "ghu_access_dup",
        refreshToken: "ghr_refresh_dup",
      }), unwrapKey, iv);

      const { request: badPasswordRequest } = await Requesting.request({
        path: "/me/github/link/complete",
        method: "POST",
        accessToken: firstAccess.accessToken,
        accountPassword: "wrong-password",
        ciphertext,
        iv,
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
        externalAccountId: "same-account",
        githubLogin: "octocat",
      });
      const [badPasswordFrame] = await Requesting._awaitResponse({
        request: badPasswordRequest,
      });
      const badPasswordResponse = badPasswordFrame.response as any;
      assertEquals(badPasswordResponse.statusCode, 401);
      assertEquals(badPasswordResponse.error, "Invalid email or password");

      const { request: firstLinkRequest } = await Requesting.request({
        path: "/me/github/link/complete",
        method: "POST",
        accessToken: firstAccess.accessToken,
        accountPassword: "password123",
        ciphertext,
        iv,
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
        externalAccountId: "same-account",
        githubLogin: "octocat",
      });
      await Requesting._awaitResponse({ request: firstLinkRequest });

      const { request: secondLinkRequest } = await Requesting.request({
        path: "/me/github/link/complete",
        method: "POST",
        accessToken: secondAccess.accessToken,
        accountPassword: "password123",
        ciphertext,
        iv,
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
        externalAccountId: "same-account",
        githubLogin: "octocat",
      });
      const [secondLinkFrame] = await Requesting._awaitResponse({
        request: secondLinkRequest,
      });
      const secondLinkResponse = secondLinkFrame.response as any;
      assertEquals(secondLinkResponse.statusCode, 409);
      assertEquals(
        secondLinkResponse.error,
        "Credential is already linked to another user.",
      );
    } finally {
      await client.close();
      restoreGitHubEnv(previousEnv);
    }
  },
});

Deno.test({
  name: "Sync: deleting account clears stored GitHub credential",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = setGitHubEnv();
    const { client, Requesting, Authenticating, Sessioning, CredentialVault } =
      await initializeSyncConcepts();
    try {
      const { user } = await Authenticating.register({
        email: "github-delete-account@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });

      await CredentialVault.storeCredential({
        user,
        provider: "github",
        ciphertext: "cipher",
        iv: "iv",
        redactedMetadata: { login: "octocat" },
        externalAccountId: "12345",
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
      });

      const { request } = await Requesting.request({
        path: "/me",
        method: "DELETE",
        accessToken,
      });
      await Requesting._awaitResponse({ request });

      assertEquals(await CredentialVault.credentials.countDocuments({}), 0);
    } finally {
      await client.close();
      restoreGitHubEnv(previousEnv);
    }
  },
});
