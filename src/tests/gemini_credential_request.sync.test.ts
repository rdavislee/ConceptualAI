import { assertEquals } from "jsr:@std/assert";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import { testDb } from "@utils/database.ts";
import {
  geminiCredentialVaultTestables,
} from "../concepts/GeminiCredentialVault/GeminiCredentialVaultConcept.ts";

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
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    cryptoKey,
    new TextEncoder().encode(geminiKey),
  );
  return bytesToBase64(new Uint8Array(encrypted));
}

Deno.test({
  name: "Sync: Gemini credential PUT/GET/DELETE flow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const GeminiCredentialVault = concepts.GeminiCredentialVault as any;

    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    GeminiCredentialVault.credentials = db.collection(
      "GeminiCredentialVault.credentials",
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/models?")) {
        return new Response(JSON.stringify({
          models: [{
            name: geminiCredentialVaultTestables.probeModel,
            supportedGenerationMethods: ["generateContent"],
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes(":generateContent?")) {
        return new Response(
          JSON.stringify({ candidates: [{ content: {} }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected URL" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      Engine.logging = Logging.VERBOSE;
      Engine.register(syncs);

      const registerResult = await Authenticating.register({
        email: "vault@test.com",
        password: "password123",
      });
      if ("error" in registerResult) throw new Error(registerResult.error);
      const user = registerResult.user;
      const { accessToken } = await Sessioning.create({ user });

      const unwrapKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
      const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
      const ciphertext = await encryptGeminiKey(
        "AIzaStoredGeminiKey1234567890",
        unwrapKey,
        iv,
      );

      const { request: putRequest } = await Requesting.request({
        path: "/me/gemini-credential",
        method: "PUT",
        accessToken,
        accountPassword: "password123",
        geminiKey: "AIzaStoredGeminiKey1234567890",
        geminiTier: "2",
        ciphertext,
        iv,
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
      });
      const [putResponseRecord] = await Requesting._awaitResponse({
        request: putRequest,
      });
      const putResponse = putResponseRecord.response as any;
      assertEquals(putResponse.hasGeminiCredential, true);
      assertEquals(putResponse.kdfSalt, "salt-value");
      assertEquals(putResponse.geminiTier, "2");

      const { request: getRequest } = await Requesting.request({
        path: "/me/gemini-credential",
        method: "GET",
        accessToken,
      });
      const [getResponseRecord] = await Requesting._awaitResponse({
        request: getRequest,
      });
      const getResponse = getResponseRecord.response as any;
      assertEquals(getResponse.hasGeminiCredential, true);
      assertEquals(getResponse.kdfSalt, "salt-value");
      assertEquals(getResponse.geminiTier, "2");

      const { request: deleteRequest } = await Requesting.request({
        path: "/me/gemini-credential",
        method: "DELETE",
        accessToken,
      });
      const [deleteResponseRecord] = await Requesting._awaitResponse({
        request: deleteRequest,
      });
      assertEquals((deleteResponseRecord.response as any).ok, true);

      const { request: getAfterDelete } = await Requesting.request({
        path: "/me/gemini-credential",
        method: "GET",
        accessToken,
      });
      const [afterDeleteRecord] = await Requesting._awaitResponse({
        request: getAfterDelete,
      });
      assertEquals((afterDeleteRecord.response as any).hasGeminiCredential, false);
    } finally {
      await client.close();
      globalThis.fetch = originalFetch;
    }
  },
});
