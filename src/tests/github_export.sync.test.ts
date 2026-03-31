import { assertEquals } from "jsr:@std/assert";
import { Binary } from "npm:mongodb";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import { freshID, testDb } from "@utils/database.ts";

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

async function initializeSyncConcepts() {
  const [db, client] = await testDb();
  const Requesting = concepts.Requesting as any;
  const Authenticating = concepts.Authenticating as any;
  const Sessioning = concepts.Sessioning as any;
  const ProjectLedger = concepts.ProjectLedger as any;
  const CredentialVault = concepts.CredentialVault as any;
  const GitHubExporting = concepts.GitHubExporting as any;

  Requesting.requests = db.collection("Requesting.requests");
  Requesting.pending = new Map();
  Authenticating.users = db.collection("Authenticating.users");
  Sessioning.sessions = db.collection("Sessioning.sessions");
  ProjectLedger.projects = db.collection("ProjectLedger.projects");
  CredentialVault.credentials = db.collection("CredentialVault.credentials");
  CredentialVault.legacyGeminiCredentials = db.collection(
    "GeminiCredentialVault.credentials",
  );
  GitHubExporting.jobs = db.collection("GitHubExporting.jobs");
  GitHubExporting.backendArtifacts = db.collection("Assembling.assemblies");
  GitHubExporting.frontendArtifacts = db.collection("FrontendGenerating.jobs");

  // Prevent sync tests from spawning git/background export work.
  GitHubExporting.runExport = async () => {};

  Engine.logging = Logging.OFF;
  Engine.register(syncs);

  return {
    db,
    client,
    Requesting,
    Authenticating,
    Sessioning,
    ProjectLedger,
    CredentialVault,
    GitHubExporting,
  };
}

async function createOwnedProject(
  ProjectLedger: any,
  owner: string,
  name = "Conceptual Export App",
) {
  const project = freshID();
  await ProjectLedger.create({
    owner,
    project,
    name,
    description: "Project for GitHub export tests",
  });
  return project;
}

async function storeGitHubCredential(
  CredentialVault: any,
  user: string,
  options?: {
    accessTokenExpiresAt?: string;
    refreshToken?: string;
  },
) {
  const unwrapKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  const iv = bytesToBase64(crypto.getRandomValues(new Uint8Array(12)));
  const ciphertext = await encryptPayload(JSON.stringify({
    accessToken: "ghu_export_access",
    refreshToken: options?.refreshToken ?? "ghr_export_refresh",
    tokenType: "bearer",
    login: "octocat",
    externalAccountId: "github-user-123",
    installationId: "6789",
    permissions: { administration: "write", contents: "write" },
    accessTokenExpiresAt:
      options?.accessTokenExpiresAt ?? "2026-04-01T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
  }), unwrapKey, iv);

  await CredentialVault.storeCredential({
    user,
    provider: "github",
    ciphertext,
    iv,
    redactedMetadata: {
      login: "octocat",
      installationId: "6789",
      permissions: { administration: "write", contents: "write" },
      tokenType: "bearer",
      accessTokenExpiresAt:
        options?.accessTokenExpiresAt ?? "2026-04-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-10-01T00:00:00.000Z",
    },
    externalAccountId: "github-user-123",
    kdfSalt: "salt-value",
    kdfParams: { algorithm: "PBKDF2", iterations: 600000 },
    encryptionVersion: "v1",
  });

  return unwrapKey;
}

Deno.test({
  name: "Sync: backend GitHub export starts successfully",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const {
      db,
      client,
      Requesting,
      Authenticating,
      Sessioning,
      ProjectLedger,
      CredentialVault,
    } = await initializeSyncConcepts();
    try {
      const { user } = await Authenticating.register({
        email: "github-export-backend@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });
      const project = await createOwnedProject(ProjectLedger, user, "Backend Export");
      const unwrapKey = await storeGitHubCredential(CredentialVault, user);
      await (db.collection("Assembling.assemblies") as any).insertOne({
        _id: project,
        status: "complete",
        zipData: new Binary(new Uint8Array([1, 2, 3])),
      });

      const { request } = await Requesting.request({
        path: `/projects/${project}/export/backend/github`,
        method: "POST",
        accessToken,
        unwrapKey,
        visibility: "private",
      });
      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.project, project);
      assertEquals(response.artifact, "backend");
      assertEquals(response.status, "processing");
      assertEquals(response.repoName, "Backend-Export-backend");
      assertEquals(response.visibility, "private");
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Sync: frontend GitHub export starts successfully",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const {
      db,
      client,
      Requesting,
      Authenticating,
      Sessioning,
      ProjectLedger,
      CredentialVault,
    } = await initializeSyncConcepts();
    try {
      const { user } = await Authenticating.register({
        email: "github-export-frontend@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });
      const project = await createOwnedProject(ProjectLedger, user, "Frontend Export");
      const unwrapKey = await storeGitHubCredential(CredentialVault, user);
      await (db.collection("FrontendGenerating.jobs") as any).insertOne({
        _id: project,
        status: "complete",
        zipData: new Binary(new Uint8Array([4, 5, 6])),
        logs: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const { request } = await Requesting.request({
        path: `/projects/${project}/export/frontend/github`,
        method: "POST",
        accessToken,
        unwrapKey,
        repoName: "custom-frontend-repo",
        visibility: "public",
      });
      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.project, project);
      assertEquals(response.artifact, "frontend");
      assertEquals(response.status, "processing");
      assertEquals(response.repoName, "custom-frontend-repo");
      assertEquals(response.visibility, "public");
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Sync: GitHub export rejects missing build artifact",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const {
      client,
      Requesting,
      Authenticating,
      Sessioning,
      ProjectLedger,
      CredentialVault,
      GitHubExporting,
    } = await initializeSyncConcepts();
    const originalRunExport = GitHubExporting.runExport;
    try {
      GitHubExporting.runExport = originalRunExport;
      const { user } = await Authenticating.register({
        email: "github-export-missing@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });
      const project = await createOwnedProject(ProjectLedger, user, "Missing Artifact");
      const unwrapKey = await storeGitHubCredential(CredentialVault, user);

      const { request } = await Requesting.request({
        path: `/projects/${project}/export/backend/github`,
        method: "POST",
        accessToken,
        unwrapKey,
      });
      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.statusCode, 404);
      assertEquals(
        response.error,
        "Requested build artifact is not available for export.",
      );
    } finally {
      GitHubExporting.runExport = originalRunExport;
      await client.close();
    }
  },
});

Deno.test({
  name: "Sync: GitHub export refresh failure returns error before export start",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const {
      db,
      client,
      Requesting,
      Authenticating,
      Sessioning,
      ProjectLedger,
      CredentialVault,
    } = await initializeSyncConcepts();
    const originalRefresh = CredentialVault.refreshGithubCredential;
    try {
      const { user } = await Authenticating.register({
        email: "github-export-refresh@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });
      const project = await createOwnedProject(ProjectLedger, user, "Expired Token");
      const unwrapKey = await storeGitHubCredential(CredentialVault, user, {
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await (db.collection("Assembling.assemblies") as any).insertOne({
        _id: project,
        status: "complete",
        zipData: new Binary(new Uint8Array([1, 2, 3])),
      });

      CredentialVault.refreshGithubCredential = async () => ({
        error: "GitHub refresh failed.",
      });

      const { request } = await Requesting.request({
        path: `/projects/${project}/export/backend/github`,
        method: "POST",
        accessToken,
        unwrapKey,
      });
      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.statusCode, 502);
      assertEquals(response.error, "GitHub refresh failed.");
    } finally {
      CredentialVault.refreshGithubCredential = originalRefresh;
      await client.close();
    }
  },
});

Deno.test({
  name: "Sync: GitHub export blocks duplicate export while repo exists and allows re-export after deletion",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const {
      db,
      client,
      Requesting,
      Authenticating,
      Sessioning,
      ProjectLedger,
      CredentialVault,
      GitHubExporting,
    } = await initializeSyncConcepts();
    const originalFetch = globalThis.fetch;
    const originalRunExport = GitHubExporting.runExport;
    try {
      GitHubExporting.runExport = async () => {};
      const { user } = await Authenticating.register({
        email: "github-export-duplicate@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });
      const project = await createOwnedProject(ProjectLedger, user, "Duplicate Export");
      const unwrapKey = await storeGitHubCredential(CredentialVault, user);
      await (db.collection("Assembling.assemblies") as any).insertOne({
        _id: project,
        status: "complete",
        zipData: new Binary(new Uint8Array([1, 2, 3])),
      });
      await GitHubExporting.createExport({
        user,
        project,
        artifact: "backend",
        repoName: "duplicate-export-backend",
        visibility: "private",
        status: "complete",
      });
      await GitHubExporting.updateExport({
        project,
        artifact: "backend",
        patch: {
          repoOwner: "octocat",
          repoUrl: "https://github.com/octocat/duplicate-export-backend",
          remoteExists: true,
        },
      });

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ id: 123 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

      const { request: duplicateRequest } = await Requesting.request({
        path: `/projects/${project}/export/backend/github`,
        method: "POST",
        accessToken,
        unwrapKey,
      });
      const [duplicateFrame] = await Requesting._awaitResponse({
        request: duplicateRequest,
      });
      const duplicateResponse = duplicateFrame.response as any;
      assertEquals(duplicateResponse.statusCode, 409);
      assertEquals(
        duplicateResponse.error,
        "This artifact is already exported to a live GitHub repository.",
      );

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

      const { request: retryRequest } = await Requesting.request({
        path: `/projects/${project}/export/backend/github`,
        method: "POST",
        accessToken,
        unwrapKey,
      });
      const [retryFrame] = await Requesting._awaitResponse({ request: retryRequest });
      const retryResponse = retryFrame.response as any;
      assertEquals(retryResponse.status, "processing");
      assertEquals(retryResponse.artifact, "backend");
    } finally {
      globalThis.fetch = originalFetch;
      GitHubExporting.runExport = originalRunExport;
      await client.close();
    }
  },
});

Deno.test({
  name: "Sync: GitHub export status returns backend and frontend job summaries",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const {
      client,
      Requesting,
      Authenticating,
      Sessioning,
      ProjectLedger,
      GitHubExporting,
    } = await initializeSyncConcepts();
    try {
      const { user } = await Authenticating.register({
        email: "github-export-status@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });
      const project = await createOwnedProject(ProjectLedger, user, "Status Export");

      await GitHubExporting.createExport({
        user,
        project,
        artifact: "backend",
        repoName: "status-backend",
        visibility: "private",
        status: "processing",
      });
      await GitHubExporting.createExport({
        user,
        project,
        artifact: "frontend",
        repoName: "status-frontend",
        visibility: "public",
        status: "complete",
      });

      const { request } = await Requesting.request({
        path: `/projects/${project}/export/github/status`,
        method: "GET",
        accessToken,
      });
      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.backend.status, "processing");
      assertEquals(response.backend.repoName, "status-backend");
      assertEquals(response.frontend.status, "complete");
      assertEquals(response.frontend.repoName, "status-frontend");
    } finally {
      await client.close();
    }
  },
});
