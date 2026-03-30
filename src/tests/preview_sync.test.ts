import { assertEquals, assertExists } from "jsr:@std/assert";
import { Binary } from "npm:mongodb";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";

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
    const Sandboxing = concepts.Sandboxing as any;

    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Assembling.assemblies = db.collection("Assembling.assemblies");
    FrontendGenerating.jobs = db.collection("FrontendGenerating.jobs");
    Previewing.previews = db.collection("Previewing.previews");
    Sandboxing.sandboxes = db.collection("Sandboxing.sandboxes");
    await Previewing.setCollectionsForTest({
      previews: Previewing.previews,
      assemblies: Assembling.assemblies,
      frontendJobs: FrontendGenerating.jobs,
    });

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
    Sandboxing.provision = async () => ({ sandboxId: "preview-sync-stub" });
    Sandboxing._isActive = async () => [{ active: false }];

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      const { user } = await Authenticating.register({
        email: "preview-sync@test.com",
        password: "pw",
      });
      const { accessToken } = await Sessioning.create({ user });

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
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "previewing");
      }

      const ready = await waitForPreviewReady(Previewing, projectId);
      assertEquals(ready.status, "ready");
      assertExists(ready.frontendUrl);

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

      // Build trigger should auto-stop preview
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/build`,
          method: "POST",
          accessToken,
          geminiKey: "test-gemini-key",
          geminiTier: "1",
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.status, "building");
      }
      const postBuildPreviewRows = await Previewing._getPreview({
        project: projectId,
      });
      assertEquals(postBuildPreviewRows[0].preview.status, "stopped");

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
        const originalTeardown = Previewing.teardown;
        Previewing.teardown = async () => ({ error: "teardown failed" });
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
          Previewing.teardown = originalTeardown;
        }
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
        });
        const [res] = await Requesting._awaitResponse({ request });
        const payload = res.response as any;
        assertEquals(payload.statusCode, 409);
      }
    } finally {
      Sandboxing.provision = originalProvision;
      Sandboxing._isActive = originalIsActive;

      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await client.close();
    }
  },
});
