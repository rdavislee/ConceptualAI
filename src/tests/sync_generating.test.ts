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
    
    // Use a unique name for this test to avoid conflicts but allow persistence
    const test_DB_NAME = `test-sync-gen-fixed_v2`;
    const db = client.db(test_DB_NAME);
    
    // We do NOT drop collections here
    
    return [db, client] as const;
}

Deno.test({
  name: "Sync: Sync Generation Integration Flow",
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
    
    try {
      // 2. Register Syncs
      Engine.logging = Logging.VERBOSE;
      Engine.register(syncs);

      // 3. User Setup (Check if exists, or create)
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
      
      // 4. Project Lifecycle
      const projectId = "test-proj-social-media-v2";
      const appDescription = "A simple social media app with user profiles, posting, commenting, and liking for authenticated users.";
      
      // Check Project Status
      let project = await ProjectLedger.projects.findOne({ _id: projectId });
      
      if (!project) {
          console.log("Project not found. Starting Planning...");
          // Step 1: Create Project
          await ProjectLedger.projects.insertOne({
              _id: projectId,
              owner: userId,
              name: "Sync Gen Social Media App",
              description: appDescription,
              status: "planning",
              createdAt: new Date(),
              updatedAt: new Date()
          });
      }
      
      // Re-fetch
      project = await ProjectLedger.projects.findOne({ _id: projectId });
      
      // --- PLANNING ---
      if (project.status === "planning") {
          console.log("Running Planner...");
          // Check if plan already exists (inconsistent state repair)
          const existingPlan = await Planning.plans.findOne({ _id: projectId });
          // If we changed the description, we should force re-planning or modify if incomplete
          // But for this test, we want to start fresh if possible or just proceed.
          
          if (existingPlan) {
              // If description changed in test but ID is same, we might have old plan.
              // Let's check if description matches
              if (existingPlan.description !== appDescription) {
                  console.log("Plan description mismatch. Deleting old plan/design/impl to restart...");
                   await ProjectLedger.projects.deleteOne({ _id: projectId });
                   await Planning.plans.deleteOne({ _id: projectId });
                   await ConceptDesigning.designs.deleteOne({ _id: projectId });
                   await Implementing.implJobs.deleteOne({ _id: projectId });
                   // Create fresh project
                   await ProjectLedger.projects.insertOne({
                      _id: projectId,
                      owner: userId,
                      name: "Sync Gen Social Media App",
                      description: appDescription,
                      status: "planning",
                      createdAt: new Date(),
                      updatedAt: new Date()
                  });
                  // Now initiate
                  const planResult = await Planning.initiate({ project: projectId, description: appDescription });
                  if (planResult.error) throw new Error(planResult.error);
                  await ProjectLedger.updateStatus({ project: projectId, status: "planning_complete" });
              } else {
                   console.log("Plan found matching description. advancing status...");
                   await ProjectLedger.updateStatus({ project: projectId, status: "planning_complete" });
              }
          } else {
              const planResult = await Planning.initiate({ project: projectId, description: appDescription });
              if (planResult.error) throw new Error(planResult.error);
              await ProjectLedger.updateStatus({ project: projectId, status: "planning_complete" });
          }
          project = await ProjectLedger.projects.findOne({ _id: projectId });
      }
      
      // --- DESIGNING ---
      if (project.status === "planning_complete") {
          console.log("Running Designer...");
          // Check if design already exists
          const existingDesign = await ConceptDesigning.designs.findOne({ _id: projectId });
          if (existingDesign) {
              console.log("Design found but status was 'planning_complete'. advancing status...");
              await ProjectLedger.updateStatus({ project: projectId, status: "design_complete" });
          } else {
              // Get the plan first
              const plans = await Planning._getPlan({ project: projectId });
              const plan = plans[0].plan.plan;
              
              const designResult = await ConceptDesigning.design({ project: projectId, plan });
              if (designResult.error) throw new Error(designResult.error);
              
              await ProjectLedger.updateStatus({ project: projectId, status: "design_complete" });
          }
          project = await ProjectLedger.projects.findOne({ _id: projectId });
      }
      
      // --- IMPLEMENTING ---
      if (project.status === "design_complete") {
          console.log("Running Implementer...");
          // Check if impl exists
          const existingImpl = await Implementing.implJobs.findOne({ _id: projectId });
          if (existingImpl) {
               console.log("Implementation found but status was 'design_complete'. advancing status...");
               await ProjectLedger.updateStatus({ project: projectId, status: "implemented" });
          } else {
              // Get design
              const designs = await ConceptDesigning._getDesign({ project: projectId });
              const design = designs[0].design;
              
              const implResult = await Implementing.implementAll({ project: projectId, design });
              if (implResult.error) throw new Error(implResult.error);
              
              await ProjectLedger.updateStatus({ project: projectId, status: "implemented" });
          }
          project = await ProjectLedger.projects.findOne({ _id: projectId });
      }
      
      // Reset status if stuck in sync_generating or building from a previous failed run
      if (project.status === "sync_generating" || project.status === "building" || project.status === "assembled") {
          console.log(`Project found in ${project.status} state. Resetting to implemented for retry.`);
          await ProjectLedger.updateStatus({ project: projectId, status: "implemented" });
          project = await ProjectLedger.projects.findOne({ _id: projectId });
      }

      // --- SYNC GENERATING (Always Run) ---
      if (project.status === "implemented" || project.status === "syncs_generated") {
          console.log("Preparing for Sync Generation...");
          
          // Force clear previous sync job to ensure we test generation
          await SyncGenerating.syncJobs.deleteOne({ _id: projectId });
          
          // 5. Trigger Sync Generation Request via API (The Test Target)
          console.log("Triggering Sync Generation request...");
          const inputs = {
            path: `/projects/${projectId}/syncs`,
            method: "POST",
            accessToken: token
          };
          
          // Requesting.request puts it in the 'requests' collection
          const { request } = await Requesting.request(inputs);
          
          console.log("Waiting for Sync Generation agent (this may take a minute)...");
          
          // This waits for the sync 'TriggerSyncGeneration' to fire, 
          // which calls SyncGenerating.generate, which runs the Python agent, 
          // which eventually returns.
          // Then 'SyncGenerationComplete' sync fires and responds.
          
          // We use a longer timeout here because we are running the actual agent
          const responseArray = await Requesting._awaitResponse({ request });
          const response = responseArray[0].response as any;
          
          if (response.status === "error") {
              console.error("Sync Generation Failed:", response.error);
              throw new Error(response.error);
          }
          
          console.log("Sync Generation Response:", response.status);
          
          // 6. Verify Response
          assertEquals(response.status, "complete");
          assertExists(response.apiDefinition);
          assertExists(response.endpointBundles);
          assertEquals(Array.isArray(response.endpointBundles), true);
          
          console.log(`Generated ${response.endpointBundles.length} endpoint bundles.`);
          
          // Verify Project Status Update
          const finalProj = await ProjectLedger.projects.findOne({ _id: projectId });
          assertEquals(finalProj.status, "syncs_generated");
          
          // 7. Test GET /syncs
          console.log("Testing GET /syncs...");
          const getInputs = {
              path: `/projects/${projectId}/syncs`,
              method: "GET",
              accessToken: token
          };
          
          const { request: getReq } = await Requesting.request(getInputs);
          const getResponseArray = await Requesting._awaitResponse({ request: getReq });
          const getResponse = getResponseArray[0].response as any;
          
          assertExists(getResponse.apiDefinition);
          assertExists(getResponse.endpointBundles);
          assertEquals(getResponse.endpointBundles.length, response.endpointBundles.length);
      } else {
          throw new Error(`Project stuck in status: ${project.status}`);
      }

    } finally {
      await client.close();
    }
  }
});
