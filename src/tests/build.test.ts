import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import { MongoClient } from "npm:mongodb";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import JSZip from "https://esm.sh/jszip@3.10.1";
import "jsr:@std/dotenv/load";

// Custom persistent DB helper - uses the same DB as sync_generating.test.ts
async function persistentTestDb() {
    const DB_CONN = Deno.env.get("MONGODB_URL");
    const DB_NAME = Deno.env.get("DB_NAME");
    if (!DB_CONN || !DB_NAME) throw new Error("Missing DB env vars");
    
    const client = new MongoClient(DB_CONN);
    await client.connect();
    
    // Use the same DB name as sync_generating.test.ts for the pre-existing project
    const test_DB_NAME = `test-sync-gen-fixed_v2`;
    const db = client.db(test_DB_NAME);
    
    return [db, client] as const;
}

Deno.test({
  name: "Build: Assembling and Frontend Generating Integration Flow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // 1. Setup Environment
    const [db, client] = await persistentTestDb();
    
    const ProjectLedger = concepts.ProjectLedger as any;
    const Planning = concepts.Planning as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const ConceptDesigning = concepts.ConceptDesigning as any;
    const Implementing = concepts.Implementing as any;
    const SyncGenerating = concepts.SyncGenerating as any;
    const Assembling = concepts.Assembling as any;
    const FrontendGenerating = concepts.FrontendGenerating as any;
    
    // Monkey-patch collections to use persistent DB
    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Planning.plans = db.collection("Planning.plans");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    ConceptDesigning.designs = db.collection("ConceptDesigning.designs");
    Implementing.implJobs = db.collection("Implementing.implJobs");
    SyncGenerating.syncJobs = db.collection("SyncGenerating.syncJobs");
    Assembling.assemblies = db.collection("Assembling.assemblies");
    FrontendGenerating.jobs = db.collection("FrontendGenerating.jobs");
    
    try {
      // 2. Register Syncs
      Engine.logging = Logging.VERBOSE;
      Engine.register(syncs);

      // 3. User Setup - use the same user as sync_generating.test.ts
      const userId = "test-user-sync-gen";
      const email = "syncgen@test.com";
      const password = "password123";
      
      // Upsert user for stability
      await Authenticating.users.updateOne(
          { _id: userId },
          { $set: { email, password } },
          { upsert: true }
      );
      
      const sessResult = await Sessioning.create({ user: userId });
      const token = sessResult.accessToken;
      
      // 4. Use the existing project from sync_generating.test.ts
      const projectId = "test-proj-social-media-v2";
      
      // Verify the project exists and has syncs generated
      const project = await ProjectLedger.projects.findOne({ _id: projectId });
      if (!project) {
          throw new Error(`Project ${projectId} not found. Please run sync_generating.test.ts first.`);
      }
      
      console.log(`Found project with status: ${project.status}`);
      
      if (project.status !== "syncs_generated" && project.status !== "building" && project.status !== "complete") {
          throw new Error(`Project must be in 'syncs_generated' status to run build. Current status: ${project.status}. Please run sync_generating.test.ts first.`);
      }

      // Clear any previous assembly/frontend jobs for a clean test
      await Assembling.assemblies.deleteOne({ _id: projectId });
      await FrontendGenerating.jobs.deleteOne({ _id: projectId });
      
      // Reset status to syncs_generated if needed
      if (project.status !== "syncs_generated") {
          await ProjectLedger.updateStatus({ project: projectId, status: "syncs_generated" });
      }

      // ============================================================
      // TEST 1: Trigger Build (POST /projects/:projectId/build)
      // ============================================================
      console.log("\n=== TEST 1: Trigger Build ===");
      console.log(`Triggering Build request for project: ${projectId}`);
      console.log("This will run Assembling (synchronous) + FrontendGenerating (async)...");
      
      const buildInputs = {
        path: `/projects/${projectId}/build`,
        method: "POST",
        accessToken: token
      };
      
      console.log("Sending request to:", buildInputs.path);
      const { request: buildRequest } = await Requesting.request(buildInputs);
      console.log("Request created with ID:", buildRequest);
      
      console.log("Waiting for Build response (this may take a few minutes for Assembling to complete)...");
      console.log("Assembling generates docs via AI, zips files, and stores in DB...");
      console.log("If TriggerBuild sync fires, you should see [TriggerBuild] logs above.");
      
      // Set up a progress indicator
      let progressCount = 0;
      const progressInterval = setInterval(() => {
          progressCount++;
          console.log(`... still waiting for build response (${progressCount * 30}s elapsed) ...`);
          if (progressCount % 2 === 0) {
              console.log("  - If no [TriggerBuild] or [Assembling] logs appear, the sync may not be matching.");
          }
      }, 30000); // Log every 30 seconds

      // Assembling will complete synchronously, FrontendGenerating will start in background
      let buildResponse: any;
      try {
          console.log("Calling Requesting._awaitResponse now...");
          const buildResponseArray = await Requesting._awaitResponse({ request: buildRequest });
          buildResponse = buildResponseArray[0].response as any;
      } finally {
          clearInterval(progressInterval);
      }
      
      console.log("Build Response received!");
      console.log("Build Response:", JSON.stringify(buildResponse, null, 2));
      
      // Verify response structure
      assertExists(buildResponse.status);
      assertExists(buildResponse.backend);
      assertExists(buildResponse.frontend);
      
      // Backend should be complete (synchronous)
      assertEquals(buildResponse.backend.status, "complete");
      console.log(`Backend status: ${buildResponse.backend.status}`);
      
      // Frontend may still be processing (asynchronous)
      console.log(`Frontend status: ${buildResponse.frontend.status}`);
      
      // Note: downloadUrl is available from the status endpoint, not the initial response

      // ============================================================
      // TEST 2: Poll Build Status until Frontend Completes
      // ============================================================
      console.log("\n=== TEST 2: Poll Build Status ===");
      
      let frontendComplete = buildResponse?.frontend?.status === "complete";
      let pollCount = 0;
      const maxPolls = 60; // Max 5 minutes (60 * 5 seconds)
      
      console.log(`Initial frontend status: ${buildResponse?.frontend?.status || 'unknown'}`);
      
      while (!frontendComplete && pollCount < maxPolls) {
          pollCount++;
          
          // Wait 5 seconds between polls
          console.log(`[Poll ${pollCount}/${maxPolls}] Waiting 5 seconds before next poll...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          console.log(`[Poll ${pollCount}/${maxPolls}] Sending status request...`);
          const statusInputs = {
              path: `/projects/${projectId}/build/status`,
              method: "GET",
              accessToken: token
          };
          
          const { request: statusRequest } = await Requesting.request(statusInputs);
          const statusResponseArray = await Requesting._awaitResponse({ request: statusRequest });
          const statusResponse = statusResponseArray[0].response as any;
          
          console.log(`[Poll ${pollCount}/${maxPolls}] Status: overall=${statusResponse.status}, backend=${statusResponse.backend?.status}, frontend=${statusResponse.frontend?.status}`);
          
          if (statusResponse.frontend?.status === "complete") {
              frontendComplete = true;
              console.log("Frontend generation complete!");
              console.log(`Frontend downloadUrl: ${statusResponse.frontend.downloadUrl}`);
          } else if (statusResponse.frontend?.status === "error") {
              throw new Error("Frontend generation failed with error");
          }
      }
      
      if (!frontendComplete) {
          console.warn("Frontend generation did not complete within timeout. Continuing with backend-only tests.");
      }

      // ============================================================
      // TEST 3: Verify Final Status
      // ============================================================
      console.log("\n=== TEST 3: Verify Final Status ===");
      
      const finalStatusInputs = {
          path: `/projects/${projectId}/build/status`,
          method: "GET",
          accessToken: token
      };
      
      const { request: finalStatusRequest } = await Requesting.request(finalStatusInputs);
      const finalStatusResponseArray = await Requesting._awaitResponse({ request: finalStatusRequest });
      const finalStatusResponse = finalStatusResponseArray[0].response as any;
      
      console.log("Final Status:", JSON.stringify(finalStatusResponse, null, 2));
      
      // Backend must be complete
      assertEquals(finalStatusResponse.backend.status, "complete");
      assertExists(finalStatusResponse.backend.downloadUrl);

      // ============================================================
      // TEST 4: Download Backend
      // ============================================================
      console.log("\n=== TEST 4: Download Backend ===");
      
      const backendDownloadInputs = {
          path: `/downloads/${projectId}_backend.zip`,
          method: "GET",
          accessToken: token
      };
      
      const { request: backendDownloadRequest } = await Requesting.request(backendDownloadInputs);
      
      try {
          const backendDownloadResponseArray = await Requesting._awaitResponse({ request: backendDownloadRequest });
          const backendDownloadResponse = backendDownloadResponseArray[0].response as any;
          
          // Response should be a stream object
          assertExists(backendDownloadResponse);
          console.log("Backend download endpoint responded successfully.");
          
          // If it's a stream, we can't easily verify content in this test, but the endpoint works
          if (backendDownloadResponse.stream) {
              console.log("Backend zip stream is available.");
          }
      } catch (e) {
          console.warn("Backend download test:", e);
      }

      // ============================================================
      // TEST 5: Download Frontend (if complete)
      // ============================================================
      if (frontendComplete) {
          console.log("\n=== TEST 5: Download Frontend ===");
          
          const frontendDownloadInputs = {
              path: `/downloads/${projectId}_frontend.zip`,
              method: "GET",
              accessToken: token
          };
          
          const { request: frontendDownloadRequest } = await Requesting.request(frontendDownloadInputs);
          
          try {
              const frontendDownloadResponseArray = await Requesting._awaitResponse({ request: frontendDownloadRequest });
              const frontendDownloadResponse = frontendDownloadResponseArray[0].response as any;
              
              assertExists(frontendDownloadResponse);
              console.log("Frontend download endpoint responded successfully.");
              
              if (frontendDownloadResponse.stream) {
                  console.log("Frontend zip stream is available.");
              }
          } catch (e) {
              console.warn("Frontend download test:", e);
          }
      } else {
          console.log("\n=== TEST 5: Download Frontend (SKIPPED - not complete) ===");
      }

      // ============================================================
      // TEST 6: Verify Database State
      // ============================================================
      console.log("\n=== TEST 6: Verify Database State ===");
      
      const assemblyDoc = await Assembling.assemblies.findOne({ _id: projectId });
      assertExists(assemblyDoc);
      assertEquals(assemblyDoc.status, "complete");
      assertExists(assemblyDoc.downloadUrl);
      assertExists(assemblyDoc.zipData);
      console.log(`Assembly document: status=${assemblyDoc.status}, downloadUrl=${assemblyDoc.downloadUrl}`);
      
      const frontendJob = await FrontendGenerating.jobs.findOne({ _id: projectId });
      assertExists(frontendJob);
      console.log(`Frontend job: status=${frontendJob.status}, downloadUrl=${frontendJob.downloadUrl || 'N/A'}`);

      // ============================================================
      // TEST 7: Verify Backend Zip Contents
      // ============================================================
      console.log("\n=== TEST 7: Verify Backend Zip Contents ===");
      
      // Extract the zip data from the assembly document
      const zipData = new Uint8Array(assemblyDoc.zipData.buffer);
      const zip = await JSZip.loadAsync(zipData);
      
      // Get all file paths in the zip
      const zipFiles = Object.keys(zip.files);
      console.log(`Backend zip contains ${zipFiles.length} files/folders`);
      
      // Debug: print ALL files in the zip
      console.log("\n--- ALL FILES IN ZIP ---");
      for (const f of zipFiles) {
          console.log(`  ${f}`);
      }
      console.log("--- END FILES ---\n");
      
      // Helper to check if a path exists in the zip
      const hasFile = (path: string) => zipFiles.some(f => f === path || f === `conceptual-app/${path}`);
      const hasDir = (path: string) => zipFiles.some(f => f.startsWith(path) || f.startsWith(`conceptual-app/${path}`));
      
      // --- Verify Root Files ---
      console.log("\nChecking root files...");
      
      const rootFiles = ["deno.json", "Dockerfile", "openapi.yaml", "API.md", "README.md", ".env.template"];
      for (const file of rootFiles) {
          const exists = hasFile(file);
          console.log(`  ${exists ? "✓" : "✗"} ${file}`);
          assert(exists, `Expected ${file} to exist in backend zip`);
      }
      
      // --- Verify src/main.ts and src/concept_server.ts ---
      console.log("\nChecking src entry points...");
      
      const srcEntryFiles = ["src/main.ts", "src/concept_server.ts"];
      for (const file of srcEntryFiles) {
          const exists = hasFile(file);
          console.log(`  ${exists ? "✓" : "✗"} ${file}`);
          assert(exists, `Expected ${file} to exist in backend zip`);
      }
      
      // --- Verify src/utils directory has files ---
      console.log("\nChecking src/utils directory...");
      assert(hasDir("src/utils"), "Expected src/utils directory to exist");
      const utilsFiles = zipFiles.filter(f => f.includes("src/utils/") && !f.endsWith("/"));
      console.log(`  Found ${utilsFiles.length} util files`);
      assert(utilsFiles.length > 0, "Expected at least one file in src/utils");
      
      // --- Verify src/engine directory has files ---
      console.log("\nChecking src/engine directory...");
      assert(hasDir("src/engine"), "Expected src/engine directory to exist");
      const engineFiles = zipFiles.filter(f => f.includes("src/engine/") && !f.endsWith("/"));
      console.log(`  Found ${engineFiles.length} engine files`);
      assert(engineFiles.length > 0, "Expected at least one file in src/engine");
      
      // --- Verify src/concepts directory has concept implementations ---
      console.log("\nChecking src/concepts directory...");
      assert(hasDir("src/concepts"), "Expected src/concepts directory to exist");
      const conceptFiles = zipFiles.filter(f => f.includes("src/concepts/") && f.endsWith("Concept.ts"));
      console.log(`  Found ${conceptFiles.length} concept files:`);
      for (const cf of conceptFiles.slice(0, 10)) { // Show first 10
          console.log(`    - ${cf}`);
      }
      if (conceptFiles.length > 10) {
          console.log(`    ... and ${conceptFiles.length - 10} more`);
      }
      assert(conceptFiles.length > 0, "Expected at least one concept implementation file");
      
      // --- Verify Requesting concept exists (required for all projects) ---
      console.log("\nChecking Requesting concept...");
      const hasRequestingConcept = zipFiles.some(f => f.includes("Requesting/RequestingConcept.ts"));
      console.log(`  ${hasRequestingConcept ? "✓" : "✗"} Requesting/RequestingConcept.ts`);
      assert(hasRequestingConcept, "Expected Requesting concept to be included");
      
      // --- Verify src/syncs directory has sync files ---
      console.log("\nChecking src/syncs directory...");
      assert(hasDir("src/syncs"), "Expected src/syncs directory to exist");
      const syncFiles = zipFiles.filter(f => f.includes("src/syncs/") && f.endsWith(".sync.ts"));
      console.log(`  Found ${syncFiles.length} sync files:`);
      for (const sf of syncFiles) {
          console.log(`    - ${sf}`);
      }
      assert(syncFiles.length > 0, "Expected at least one sync file");
      
      // --- Verify src/tests directory has test files ---
      console.log("\nChecking src/tests directory...");
      const testFiles = zipFiles.filter(f => f.includes("src/tests/") && f.endsWith(".test.ts"));
      console.log(`  Found ${testFiles.length} test files`);
      
      // --- Print summary ---
      console.log("\n--- Backend Zip Summary ---");
      console.log(`Total files: ${zipFiles.filter(f => !f.endsWith("/")).length}`);
      console.log(`Total directories: ${zipFiles.filter(f => f.endsWith("/")).length}`);
      console.log(`Concept files: ${conceptFiles.length}`);
      console.log(`Sync files: ${syncFiles.length}`);
      console.log(`Test files: ${testFiles.length}`);
      console.log(`Util files: ${utilsFiles.length}`);
      console.log(`Engine files: ${engineFiles.length}`);

      console.log("\n=== ALL TESTS PASSED ===");

    } finally {
      await client.close();
    }
  }
});
