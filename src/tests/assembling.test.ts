import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { MongoClient } from "npm:mongodb";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import JSZip from "https://esm.sh/jszip@3.10.1";
import "jsr:@std/dotenv/load";

// Custom persistent DB helper for this test
async function persistentTestDb() {
  const DB_CONN = Deno.env.get("MONGODB_URL");
  const DB_NAME = Deno.env.get("DB_NAME");
  if (!DB_CONN || !DB_NAME) throw new Error("Missing DB env vars");

  const client = new MongoClient(DB_CONN);
  await client.connect();

  // Reuse the DB from sync_generating.test.ts
  const test_DB_NAME = `test-sync-gen-fixed_v2`;
  const db = client.db(test_DB_NAME);

  return [db, client] as const;
}

Deno.test({
  name:
    "Build: Triggers backend assembly + frontend generation, polls until both complete",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // 1. Setup Environment
    const [db, client] = await persistentTestDb();

    const ProjectLedger = concepts.ProjectLedger as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Assembling = concepts.Assembling as any;
    const FrontendGenerating = concepts.FrontendGenerating as any;
    const Planning = concepts.Planning as any;
    const Implementing = concepts.Implementing as any;
    const SyncGenerating = concepts.SyncGenerating as any;
    const ConceptDesigning = concepts.ConceptDesigning as any;

    // Monkey-patch collections to use persistent DB
    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Assembling.assemblies = db.collection("Assembling.assemblies");
    FrontendGenerating.jobs = db.collection("FrontendGenerating.jobs");
    Planning.plans = db.collection("Planning.plans");
    Implementing.implJobs = db.collection("Implementing.implJobs");
    SyncGenerating.syncJobs = db.collection("SyncGenerating.syncJobs");
    ConceptDesigning.designs = db.collection("ConceptDesigning.designs");

    // Setup GridFS bucket for Assembling
    const { GridFSBucket } = await import("npm:mongodb");
    Assembling.gridfs = new GridFSBucket(db, { bucketName: "assemblies" });

    try {
      // 2. Register Syncs
      Engine.logging = Logging.VERBOSE;
      Engine.register(syncs);

      // 3. User Setup
      const userId = "test-user-sync-gen";
      const email = "syncgen@test.com";
      const password = "password123";

      // Upsert user
      await Authenticating.users.updateOne(
        { _id: userId },
        { $set: { email, password } },
        { upsert: true },
      );

      const sessResult = await Sessioning.create({ user: userId });
      const token = sessResult.accessToken;
      const geminiKey = Deno.env.get("GEMINI_API_KEY") || "test-key";
      const geminiTier = Deno.env.get("GEMINI_TIER") || "1";

      // 4. Project Setup
      const projectId = "test-proj-social-media-v2";

      // Check Project exists
      const project = await ProjectLedger.projects.findOne({ _id: projectId });
      if (!project) {
        throw new Error(
          `Project ${projectId} not found. Did you run sync_generating.test.ts first?`,
        );
      }

      console.log(`Found project with status: ${project.status}`);

      // Reset to syncs_generated for clean test
      if (project.status !== "syncs_generated") {
        console.log(
          `Resetting project status from ${project.status} to syncs_generated...`,
        );
        await ProjectLedger.projects.updateOne({ _id: projectId }, {
          $set: { status: "syncs_generated" },
        });
      }

      // Cleanup previous builds
      await Assembling.assemblies.deleteOne({ _id: projectId });
      await FrontendGenerating.jobs.deleteOne({ _id: projectId });

      // ============================================================
      // TEST 1: Trigger Build (POST /projects/:projectId/build)
      // ============================================================
      console.log("\n=== TEST 1: Trigger Build ===");
      console.log(`Triggering Build for project: ${projectId}`);

      const buildInputs = {
        path: `/projects/${projectId}/build`,
        method: "POST",
        accessToken: token,
        geminiKey,
        geminiTier,
      };

      const { request: buildRequest } = await Requesting.request(buildInputs);
      console.log("Request created:", buildRequest);

      // Wait for immediate response
      const buildResponseArray = await Requesting._awaitResponse({
        request: buildRequest,
      });
      const buildResponse = buildResponseArray[0].response as any;

      console.log("Build Response:", JSON.stringify(buildResponse, null, 2));

      // Initial response should be "processing"
      assertEquals(buildResponse.status, "processing");
      assertExists(buildResponse.message);
      console.log(
        "Build triggered successfully, now polling for completion...",
      );

      // ============================================================
      // TEST 2: Poll Build Status until BOTH complete
      // ============================================================
      console.log("\n=== TEST 2: Poll Build Status ===");

      let buildComplete = false;
      let pollCount = 0;
      const maxPolls = 120; // Max 10 minutes (120 * 5 seconds)
      let lastStatus: any = null;

      while (!buildComplete && pollCount < maxPolls) {
        pollCount++;

        // Wait 5 seconds between polls
        console.log(`[Poll ${pollCount}/${maxPolls}] Waiting 5 seconds...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const statusInputs = {
          path: `/projects/${projectId}/build/status`,
          method: "GET",
          accessToken: token,
          geminiKey,
          geminiTier,
        };

        const { request: statusRequest } = await Requesting.request(
          statusInputs,
        );
        const statusResponseArray = await Requesting._awaitResponse({
          request: statusRequest,
        });
        lastStatus = statusResponseArray[0].response as any;

        console.log(
          `[Poll ${pollCount}/${maxPolls}] Status: overall=${lastStatus.status}, backend=${lastStatus.backend?.status}, frontend=${lastStatus.frontend?.status}`,
        );

        if (lastStatus.status === "complete") {
          buildComplete = true;
          console.log("Both backend and frontend complete!");
        } else if (lastStatus.status === "error") {
          throw new Error("Build failed with error");
        }
      }

      if (!buildComplete) {
        console.warn("Build did not complete within timeout.");
        console.log("Last status:", JSON.stringify(lastStatus, null, 2));
      }

      // ============================================================
      // TEST 3: Verify Final State
      // ============================================================
      console.log("\n=== TEST 3: Verify Final State ===");

      // Verify backend complete
      assertExists(lastStatus.backend);
      assertEquals(lastStatus.backend.status, "complete");
      assertExists(lastStatus.backend.downloadUrl);
      console.log(`Backend downloadUrl: ${lastStatus.backend.downloadUrl}`);

      // Verify frontend complete
      assertExists(lastStatus.frontend);
      assertEquals(lastStatus.frontend.status, "complete");
      assertExists(lastStatus.frontend.downloadUrl);
      console.log(`Frontend downloadUrl: ${lastStatus.frontend.downloadUrl}`);

      // Verify project status is "assembled"
      const finalProject = await ProjectLedger.projects.findOne({
        _id: projectId,
      });
      assertEquals(finalProject.status, "assembled");
      console.log("Project status correctly set to 'assembled'");

      // ============================================================
      // TEST 4: Verify Database Documents
      // ============================================================
      console.log("\n=== TEST 4: Verify Database Documents ===");

      // Verify Assembly doc
      const assemblyDoc = await Assembling.assemblies.findOne({
        _id: projectId,
      });
      assertExists(assemblyDoc);
      assertEquals(assemblyDoc.status, "complete");
      assertExists(assemblyDoc.downloadUrl);
      assertExists(assemblyDoc.zipData);
      console.log(`Assembly document: status=${assemblyDoc.status}`);

      // Verify Frontend job
      const frontendJob = await FrontendGenerating.jobs.findOne({
        _id: projectId,
      });
      assertExists(frontendJob);
      assertEquals(frontendJob.status, "complete");
      assertExists(frontendJob.downloadUrl);
      console.log(`Frontend job: status=${frontendJob.status}`);

      // ============================================================
      // TEST 5: Verify Backend Zip Contents
      // ============================================================
      console.log("\n=== TEST 5: Verify Backend Zip Contents ===");

      const zipData = new Uint8Array(assemblyDoc.zipData.buffer);
      const zip = await JSZip.loadAsync(zipData);
      const zipFiles = Object.keys(zip.files);

      console.log(`Backend zip contains ${zipFiles.length} files/folders`);

      // Helper functions
      const hasFile = (path: string) =>
        zipFiles.some((f) => f === path || f === `conceptual-app/${path}`);
      const hasDir = (path: string) =>
        zipFiles.some((f) =>
          f.startsWith(path) || f.startsWith(`conceptual-app/${path}`)
        );

      // Check essential files
      const essentialFiles = ["deno.json", "Dockerfile", "openapi.yaml"];
      for (const file of essentialFiles) {
        const exists = hasFile(file);
        console.log(`  ${exists ? "✓" : "✗"} ${file}`);
        assert(exists, `Expected ${file} to exist in backend zip`);
      }

      // Check src directories
      assert(hasDir("src/concepts"), "Expected src/concepts directory");
      assert(hasDir("src/syncs"), "Expected src/syncs directory");

      const conceptFiles = zipFiles.filter((f) =>
        f.includes("src/concepts/") && f.endsWith("Concept.ts")
      );
      const syncFiles = zipFiles.filter((f) =>
        f.includes("src/syncs/") && f.endsWith(".sync.ts")
      );

      console.log(`  Found ${conceptFiles.length} concept files`);
      console.log(`  Found ${syncFiles.length} sync files`);

      assert(conceptFiles.length > 0, "Expected at least one concept file");
      assert(syncFiles.length > 0, "Expected at least one sync file");

      console.log("\n=== ALL TESTS PASSED ===");
    } finally {
      await client.close();
    }
  },
});
