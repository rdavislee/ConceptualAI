import { assertEquals } from "jsr:@std/assert";
import { Engine } from "@concepts";
import * as concepts from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import { testDb } from "@utils/database.ts";

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

Deno.test({
  name: "Sync: POST /projects rejects missing Gemini unwrap key before provisioning",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ProjectLedger = concepts.ProjectLedger as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Sandboxing = concepts.Sandboxing as any;

    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Sandboxing.sandboxes = db.collection("Sandboxing.sandboxes");

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      const { user } = await Authenticating.register({
        email: "missing-unwrap@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });

      const { request } = await Requesting.request({
        path: "/projects",
        method: "POST",
        name: "Missing unwrap app",
        description: "Should fail before project creation.",
        accessToken,
        geminiUnwrapKey: "",
      });

      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.statusCode, 400);
      assertEquals(
        response.error,
        "Missing required header: X-Gemini-Unwrap-Key.",
      );
      assertEquals(await ProjectLedger.projects.countDocuments({}), 0);
      assertEquals(await Sandboxing.sandboxes.countDocuments({}), 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Sync: POST /projects rejects invalid Gemini unwrap key before provisioning",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ProjectLedger = concepts.ProjectLedger as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Sandboxing = concepts.Sandboxing as any;
    const GeminiCredentialVault = concepts.GeminiCredentialVault as any;

    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Sandboxing.sandboxes = db.collection("Sandboxing.sandboxes");
    GeminiCredentialVault.credentials = db.collection(
      "GeminiCredentialVault.credentials",
    );

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      const { user } = await Authenticating.register({
        email: "invalid-unwrap@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });

      const correctUnwrapKey = bytesToBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const wrongUnwrapKey = bytesToBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
      const ciphertext = await encryptGeminiKey(
        "AIzaStoredGeminiKey1234567890",
        correctUnwrapKey,
        iv,
      );

      await GeminiCredentialVault.storeCredential({
        user,
        ciphertext,
        iv,
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
        geminiTier: "2",
      });

      const { request } = await Requesting.request({
        path: "/projects",
        method: "POST",
        name: "Invalid unwrap app",
        description: "Should fail before project creation.",
        accessToken,
        geminiUnwrapKey: wrongUnwrapKey,
      });

      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.statusCode, 401);
      assertEquals(response.error, "Invalid Gemini unwrap key.");
      assertEquals(await ProjectLedger.projects.countDocuments({}), 0);
      assertEquals(await Sandboxing.sandboxes.countDocuments({}), 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Sync: GET /projects/:id/build/status rejects missing Gemini unwrap key",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ProjectLedger = concepts.ProjectLedger as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;

    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      const { user } = await Authenticating.register({
        email: "status-unwrap@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });

      const { request } = await Requesting.request({
        path: "/projects/project-123/build/status",
        method: "GET",
        accessToken,
        geminiUnwrapKey: "",
      });

      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.statusCode, 400);
      assertEquals(
        response.error,
        "Missing required header: X-Gemini-Unwrap-Key.",
      );
    } finally {
      await client.close();
    }
  },
});
