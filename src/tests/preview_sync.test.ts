import { assertEquals, assertExists } from "jsr:@std/assert";
import { Binary } from "npm:mongodb";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { createPreviewProviderFromEnv } from "@concepts/Previewing/providers/index.ts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import {
  credentialVaultTestables,
} from "../concepts/CredentialVault/CredentialVaultConcept.ts";

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakePreviewProvider {
  launches: Array<{
    launchId: string;
    backendEnv?: Record<string, string>;
  }> = [];
  teardowns: Array<{ backendAppId?: string; frontendAppId?: string }> = [];
  blockTeardown = false;
  teardownDeferreds: Array<ReturnType<typeof createDeferred<void>>> = [];

  async launch(
    input: { launchId: string; backendEnv?: Record<string, string> },
  ) {
    this.launches.push({
      launchId: input.launchId,
      backendEnv: input.backendEnv,
    });
    return {
      backendAppId: `backend-${input.launchId}`,
      backendUrl: `https://preview.example.com/backend-${input.launchId}`,
      frontendAppId: `frontend-${input.launchId}`,
      frontendUrl: `https://preview.example.com/frontend-${input.launchId}`,
    };
  }

  async teardown(
    input: { backendAppId?: string; frontendAppId?: string },
  ): Promise<void> {
    this.teardowns.push(input);
    if (this.blockTeardown) {
      const deferred = createDeferred<void>();
      this.teardownDeferreds.push(deferred);
      await deferred.promise;
    }
  }

  releaseNextTeardown() {
    const deferred = this.teardownDeferreds.shift();
    if (!deferred) {
      throw new Error("No pending teardown to release.");
    }
    deferred.resolve();
  }
}

async function waitForPreviewReady(Previewing: any, projectId: string) {
  for (let i = 0; i < 80; i++) {
    const rows = await Previewing._getPreview({ project: projectId });
    const preview = rows[0]?.preview;
    const status = preview?.status;
    if (status === "ready") return rows[0].preview;
    if (status === "error") {
      throw new Error(
        `Preview entered error state: ${preview?.lastError || "unknown error"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const rows = await Previewing._getPreview({ project: projectId });
  const preview = rows[0]?.preview;
  throw new Error(
    `Timed out waiting for preview to become ready. lastStatus=${
      preview?.status || "none"
    } lastError=${preview?.lastError || ""}`,
  );
}

async function waitForPreviewStatus(
  Previewing: any,
  projectId: string,
  expected: string,
) {
  for (let i = 0; i < 80; i++) {
    const rows = await Previewing._getPreview({ project: projectId });
    const preview = rows[0]?.preview;
    if (preview?.status === expected) return preview;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const rows = await Previewing._getPreview({ project: projectId });
  throw new Error(
    `Timed out waiting for preview status=${expected}. got=${
      rows[0]?.preview?.status || "none"
    }`,
  );
}

async function waitForTeardownCount(
  provider: FakePreviewProvider,
  expected: number,
) {
  for (let i = 0; i < 80; i++) {
    if (provider.teardowns.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for teardown count=${expected}. got=${provider.teardowns.length}`,
  );
}

Deno.test({
  name: "Sync: preview launch/status/teardown and build-trigger cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();

    const ProjectLedger = concepts.ProjectLedger as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Assembling = concepts.Assembling as any;
    const FrontendGenerating = concepts.FrontendGenerating as any;
    const Previewing = concepts.Previewing as any;
    const CredentialVault = concepts.CredentialVault as any;
    const Sandboxing = concepts.Sandboxing as any;
    const fakeProvider = new FakePreviewProvider();

    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Assembling.assemblies = db.collection("Assembling.assemblies");
    FrontendGenerating.jobs = db.collection("FrontendGenerating.jobs");
    Previewing.previews = db.collection("Previewing.previews");
    CredentialVault.credentials = db.collection("CredentialVault.credentials");
    Sandboxing.sandboxes = db.collection("Sandboxing.sandboxes");
    await Previewing.setCollectionsForTest({
      previews: Previewing.previews,
      assemblies: Assembling.assemblies,
      frontendJobs: FrontendGenerating.jobs,
    });
    Previewing.setProviderFactoryForTest.action(() => fakeProvider);

    const previousEnv = {
      PREVIEWS_ENABLED: Deno.env.get("PREVIEWS_ENABLED"),
      PREVIEW_PROVIDER: Deno.env.get("PREVIEW_PROVIDER"),
      PREVIEW_MAX_ACTIVE_PER_USER: Deno.env.get("PREVIEW_MAX_ACTIVE_PER_USER"),
      PREVIEW_MONGODB_URL: Deno.env.get("PREVIEW_MONGODB_URL"),
    };
    Deno.env.set("PREVIEWS_ENABLED", "true");
    Deno.env.set("PREVIEW_PROVIDER", "mock");
    Deno.env.set("PREVIEW_MAX_ACTIVE_PER_USER", "1");
    Deno.env.set("PREVIEW_MONGODB_URL", Deno.env.get("MONGODB_URL") || "");

    const originalProvision = Sandboxing.provision;
    const originalIsActive = Sandboxing._isActive;
    const originalFetch = globalThis.fetch;
    Sandboxing.provision = async () => ({ sandboxId: "preview-sync-stub" });
    Sandboxing._isActive = async () => [{ active: false }];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/models?")) {
        return new Response(
          JSON.stringify({
            models: [{
              name: credentialVaultTestables.probeModel,
              supportedGenerationMethods: ["generateContent"],
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes(":generateContent?")) {
        return new Response(
          JSON.stringify({ candidates: [{ content: {} }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "Unexpected URL" } }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      const { user } = await Authenticating.register({
        email: "preview-sync@test.com",
        password: "pw",
      });
      const { accessToken } = await Sessioning.create({ user });
      const unwrapKey = bytesToBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
      const storedGeminiKey = "AIzaStoredGeminiKey1234567890";
      const ciphertext = await encryptGeminiKey(
        storedGeminiKey,
        unwrapKey,
        iv,
      );
      await CredentialVault.storeCredential({
        user,
        provider: "gemini",
        ciphertext,
        iv,
        redactedMetadata: { geminiTier: "2" },
        kdfSalt: "salt-value",
        kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
        encryptionVersion: "v1",
      });

      const projectId = "preview-sync-project";
      await ProjectLedger.projects.insertOne({
        _id: projectId,
        owner: user,
        name: "Preview Sync Project",
        description: "preview sync test",
        status: "assembled",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await Assembling.assemblies.insertOne({
        _id: projectId,
        downloadUrl: `/api/downloads/${projectId}_backend.zip`,
        zipData: new Binary(new Uint8Array([1, 2, 3])),
        status: "complete",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await FrontendGenerating.jobs.insertOne({
        _id: projectId,
        status: "complete",
        downloadUrl: `/api/downloads/${projectId}_frontend.zip`,
        zipData: new Binary(new Uint8Array([4, 5, 6])),
        logs: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Launch preview
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview`,
          method: "POST",
          accessToken,
          geminiUnwrapKey: unwrapKey,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "previewing");
      }

      const ready = await waitForPreviewReady(Previewing, projectId);
      assertEquals(ready.status, "ready");
      assertExists(ready.frontendUrl);
      assertEquals(
        fakeProvider.launches[0]?.backendEnv?.GEMINI_API_KEY,
        storedGeminiKey,
      );
      assertEquals(fakeProvider.launches[0]?.backendEnv?.GEMINI_TIER, "2");

      // GET status should surface ready URLs
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/status`,
          method: "GET",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "ready");
        assertExists(payload.frontendUrl);
        assertExists(payload.backendUrl);
      }

      // Expiry should schedule teardown and surface preview_stopping before expired.
      fakeProvider.blockTeardown = true;
      await Previewing.previews.updateOne(
        { _id: projectId },
        {
          $set: {
            expiresAt: new Date(Date.now() - 1_000),
            updatedAt: new Date(),
          },
        },
      );
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/status`,
          method: "GET",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "preview_stopping");
      }
      await waitForPreviewStatus(Previewing, projectId, "stopping");
      await waitForTeardownCount(fakeProvider, 1);

      fakeProvider.releaseNextTeardown();
      fakeProvider.blockTeardown = false;
      await waitForPreviewStatus(Previewing, projectId, "expired");
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/status`,
          method: "GET",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "expired");
      }

      // Relaunch after async expiry teardown so manual teardown coverage still exercises a live preview.
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview`,
          method: "POST",
          accessToken,
          geminiUnwrapKey: unwrapKey,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "previewing");
      }

      await waitForPreviewReady(Previewing, projectId);

      // Teardown route should return preview_stopping immediately and poll to preview_stopped.
      fakeProvider.blockTeardown = true;
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/teardown`,
          method: "POST",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "preview_stopping");
      }
      await waitForPreviewStatus(Previewing, projectId, "stopping");
      await waitForTeardownCount(fakeProvider, 1);

      // Even if the persisted doc is touched early, the status route should stay stopping
      // until the in-memory teardown task has actually completed.
      await Previewing.previews.updateOne(
        { _id: projectId },
        { $set: { status: "stopped", updatedAt: new Date() } },
      );
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/status`,
          method: "GET",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "preview_stopping");
      }

      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/teardown`,
          method: "POST",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "preview_stopping");
      }
      assertEquals(fakeProvider.teardowns.length, 1);

      fakeProvider.releaseNextTeardown();
      fakeProvider.blockTeardown = false;
      await waitForPreviewStatus(Previewing, projectId, "stopped");
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/status`,
          method: "GET",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "preview_stopped");
      }

      // Relaunch after async teardown so build-trigger cleanup still exercises a live preview.
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview`,
          method: "POST",
          accessToken,
          geminiUnwrapKey: unwrapKey,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "previewing");
      }

      await waitForPreviewReady(Previewing, projectId);
      // Build trigger should auto-stop preview
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/build`,
          method: "POST",
          accessToken,
          geminiUnwrapKey: unwrapKey,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "building");
      }
      const postBuildPreviewRows = await Previewing._getPreview({
        project: projectId,
      });
      assertEquals(postBuildPreviewRows[0].preview.status, "stopped");
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/status`,
          method: "GET",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "preview_stopped");
      }

      // Teardown endpoint should still succeed on stopped previews
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/preview/teardown`,
          method: "POST",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "preview_stopped");
      }

      // Teardown endpoint should surface teardown failures instead of reporting success.
      {
        const originalBeginTeardown = Previewing.beginTeardown;
        Previewing.beginTeardown = async () => ({ error: "teardown failed" });
        try {
          const { request } = await Requesting.request({
            path: `/projects/${projectId}/preview/teardown`,
            method: "POST",
            accessToken,
          });
          const [res] = await Requesting._awaitResponse({ request });
          const payload = res.response as any;
          assertEquals(payload.status, "preview_stop_failed");
          assertEquals(payload.statusCode, 500);
          assertEquals(payload.error, "teardown failed");
        } finally {
          Previewing.beginTeardown = originalBeginTeardown;
        }
      }

      // Existing projects without preview documents should still return none.
      {
        const neverPreviewedProjectId = "preview-sync-never-started";
        await ProjectLedger.projects.insertOne({
          _id: neverPreviewedProjectId,
          owner: user,
          name: "Never Previewed",
          description: "no preview doc",
          status: "assembled",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const { request } = await Requesting.request({
          path: `/projects/${neverPreviewedProjectId}/preview/status`,
          method: "GET",
          accessToken,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "none");
      }

      // Invalid stage returns 409 from route preconditions.
      {
        const invalidProjectId = "preview-invalid-stage";
        await ProjectLedger.projects.insertOne({
          _id: invalidProjectId,
          owner: user,
          name: "Invalid Stage",
          description: "invalid stage test",
          status: "syncs_generated",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const { request } = await Requesting.request({
          path: `/projects/${invalidProjectId}/preview`,
          method: "POST",
          accessToken,
          geminiUnwrapKey: unwrapKey,
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.statusCode, 409);
      }
    } finally {
      Sandboxing.provision = originalProvision;
      Sandboxing._isActive = originalIsActive;
      globalThis.fetch = originalFetch;
      Previewing.setProviderFactoryForTest.action(createPreviewProviderFromEnv);

      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await client.close();
    }
  },
});
