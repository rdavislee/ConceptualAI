import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import {
  geminiCredentialVaultTestables,
} from "./GeminiCredentialVaultConcept.ts";
import GeminiCredentialVaultConcept from "./GeminiCredentialVaultConcept.ts";

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function encryptGeminiKey(
  geminiKey: string,
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
    new TextEncoder().encode(geminiKey),
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

mongoTest("GeminiCredentialVault stores status metadata and existence", async () => {
  const [db, client] = await testDb();
  const vault = new GeminiCredentialVaultConcept(db);
  const user = "user-1" as ID;
  try {
    const beforeStatus = await vault._getStatus({ user });
    assertEquals(beforeStatus, [{ hasGeminiCredential: false }]);

    const storeResult = await vault.storeCredential({
      user,
      ciphertext: "ciphertext-value",
      iv: "iv-value",
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
      geminiTier: "2",
    });
    assertEquals(storeResult, { ok: true });

    const hasCredential = await vault._hasCredential({ user });
    assertEquals(hasCredential, [{ hasGeminiCredential: true }]);

    const status = await vault._getStatus({ user });
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

mongoTest("GeminiCredentialVault resolves plaintext Gemini key with unwrap key", async () => {
  const [db, client] = await testDb();
  const vault = new GeminiCredentialVaultConcept(db);
  const user = "user-2" as ID;
  try {
    const unwrapKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const unwrapKey = bytesToBase64(unwrapKeyBytes);
    const iv = bytesToBase64(ivBytes);
    const ciphertext = await encryptGeminiKey(
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
            name: geminiCredentialVaultTestables.probeModel,
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
        ciphertext,
        iv,
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
        geminiTier: "3",
      });
      assertEquals(storeResult, { ok: true });

      const resolved = await vault._resolveCredential({
        user,
        unwrapKey,
      });
      assertEquals(resolved, [{
        geminiKey: "AIzaStoredGeminiKey1234567890",
        geminiTier: "3",
      }]);

      const invalidResolved = await vault._resolveCredential({
        user,
        unwrapKey: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
      });
      assertEquals(invalidResolved, [{
        error: "Invalid Gemini unwrap key.",
        statusCode: 401,
      }]);

      const missingResolved = await vault._resolveCredential({
        user,
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

mongoTest("GeminiCredentialVault deleteCredential removes stored credential", async () => {
  const [db, client] = await testDb();
  const vault = new GeminiCredentialVaultConcept(db);
  const user = "user-3" as ID;
  try {
    await vault.storeCredential({
      user,
      ciphertext: "ciphertext-value",
      iv: "iv-value",
      kdfSalt: "salt-value",
      kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
      encryptionVersion: "v1",
      geminiTier: "1",
    });

    const deleteResult = await vault.deleteCredential({ user });
    assertEquals(deleteResult, { ok: true });
    const status = await vault._getStatus({ user });
    assertEquals(status, [{ hasGeminiCredential: false }]);
  } finally {
    await client.close();
  }
});

mongoTest("GeminiCredentialVault verifyGeminiCredential returns provider validation errors", async () => {
  const [db, client] = await testDb();
  const vault = new GeminiCredentialVaultConcept(db);
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(401, { error: { message: "API key not valid." } })) as
      typeof fetch;

    try {
      const result = await vault.verifyGeminiCredential({
        apiKey: "AIzaInvalidKey123456789012345",
        geminiTier: "1",
      });
      assertEquals(result, {
        ok: false,
        statusCode: 400,
        error: "Invalid Gemini API key.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await client.close();
  }
});

mongoTest("GeminiCredentialVault verifyGeminiCredential succeeds for paid key", async () => {
  const [db, client] = await testDb();
  const vault = new GeminiCredentialVaultConcept(db);
  try {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls += 1;
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/models?")) {
        return jsonResponse(200, {
          models: [{
            name: geminiCredentialVaultTestables.probeModel,
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
      const result = await vault.verifyGeminiCredential({
        apiKey: "AIzaPaidTierLikeKey1234567890",
        geminiTier: "2",
      });
      assertEquals(result, { ok: true });
      assertEquals(fetchCalls, 2);
      const stored = await vault.credentials.findOne({ _id: "missing" as ID });
      assertEquals(stored, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await client.close();
  }
});
