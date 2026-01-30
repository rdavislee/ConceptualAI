import { assertEquals, assertExists } from "jsr:@std/assert";
import { MongoClient } from "npm:mongodb";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
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
  name: "Sync: Assembly Integration Flow",
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
    Planning.plans = db.collection("Planning.plans");
    Implementing.implJobs = db.collection("Implementing.implJobs");
    SyncGenerating.syncJobs = db.collection("SyncGenerating.syncJobs");
    ConceptDesigning.designs = db.collection("ConceptDesigning.designs");

    // Important: We need to set the gridfs bucket on the Assembling concept instance
    // Since we monkey-patched the collections, we might need to be careful about the gridfs bucket
    // But AssemblingConcept constructor initializes gridfs. 
    // The instance 'concepts.Assembling' was initialized with the main DB.
    // We can't easily swap the gridfs bucket of the exported singleton.
    // However, the logic uses `this.gridfs`. 
    // We can try to manually set it if we can access it, or just accept that it might write to the main DB's gridfs?
    // Wait, `concepts.Assembling` is an instance.
    // Ideally we should construct a new instance with our test DB, but the Syncs use the exported instance.
    // So we might be writing zip files to the main DB "assemblies" bucket. 
    // That's acceptable for a local test, but we should be aware.
    // A better way is to update the instance's gridfs bucket if possible, but it's private.
    // monkey-patching:
    // Assembling.gridfs = new GridFSBucket(db, { bucketName: "assemblies" });
    // This requires casting to any, which we did.

    const { GridFSBucket } = await import("npm:mongodb");
    Assembling.gridfs = new GridFSBucket(db, { bucketName: "assemblies" });

    try {
      // 2. Register Syncs
      Engine.logging = Logging.VERBOSE;
      Engine.register(syncs);

      // 3. User Setup
      const userId = "test-user-sync-gen"; // Reuse user from previous test
      
      // Get session
      // We need a valid token. The previous test created one, but we don't have it.
      // We can create a new session.
      const sessResult = await Sessioning.create({ user: userId });
      const token = sessResult.accessToken;
      
      // 4. Project Setup
      const projectId = "test-proj-social-media-v2"; // Reuse project from previous test

      // Check Project Status
      const project = await ProjectLedger.projects.findOne({ _id: projectId });
      if (!project) {
          throw new Error(`Project ${projectId} not found. Did you run sync_generating.test.ts first?`);
      }
      
      // Reset status to ensure sync triggers
      if (project.status !== "syncs_generated") {
           console.log(`Resetting project status from ${project.status} to syncs_generated...`);
           await ProjectLedger.projects.updateOne({ _id: projectId }, { $set: { status: "syncs_generated" } });
      }

      // Cleanup previous assembly to force regeneration
      await Assembling.assemblies.deleteOne({ _id: projectId });

      // 5. Trigger Assembly
      console.log("Triggering Assembly request...");
      const inputs = {
        path: `/projects/${projectId}/assemble`,
        method: "POST",
        accessToken: token
      };
      
      const { request } = await Requesting.request(inputs);
      
      console.log("Waiting for Assembly agent (this may take a minute)...");
      
      // This waits for the sync 'TriggerAssembly' to fire
      const responseArray = await Requesting._awaitResponse({ request });
      const response = responseArray[0].response as any;
      
      if (response.status === "error") {
          console.error("Assembly Failed:", response.error);
          throw new Error(response.error);
      }
      
      console.log("Assembly Response:", response.status);
      
      // 6. Verify Response
      assertEquals(response.status, "complete");
      assertExists(response.downloadUrl);
      console.log(`Download URL: ${response.downloadUrl}`);
      
      // Verify Project Status Update
      const finalProj = await ProjectLedger.projects.findOne({ _id: projectId });
      assertEquals(finalProj.status, "complete");
      
      // Verify Assembly Doc
      const assemblyDoc = await Assembling.assemblies.findOne({ _id: projectId });
      assertExists(assemblyDoc);
      assertEquals(assemblyDoc.downloadUrl, response.downloadUrl);

      // 7. Test Download Endpoint
      console.log("Testing Download endpoint...");
      // The download URL is /api/downloads/:project.zip
      // Requesting.request handles paths relative to /api (REQUESTING_BASE_URL default)
      // So if downloadUrl is /api/downloads/..., we strip /api?
      // Wait, Requesting.request expects `path`. 
      // If the URL is `/api/downloads/xyz.zip`, and base is `/api`, the path for Requesting is `/downloads/xyz.zip`.
      // Let's assume standard config.
      
      const downloadPath = response.downloadUrl.replace("/api", ""); // quick fix for test env
      const downloadInputs = {
          path: downloadPath,
          method: "GET",
          accessToken: token
      };

      const { request: dlReq } = await Requesting.request(downloadInputs);
      const dlResponseArray = await Requesting._awaitResponse({ request: dlReq });
      const dlResponse = dlResponseArray[0].response as any;

      // RequestingConcept.respond with a stream returns the Response object to Hono, 
      // but internal _awaitResponse just returns the object passed to respond().
      // In our sync, we passed { stream, headers }.
      
      assertExists(dlResponse.stream);
      assertEquals(dlResponse.headers["Content-Type"], "application/zip");
      console.log("Download endpoint returned stream successfully.");

    } finally {
      await client.close();
    }
  }
});
