import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts"; 
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

/**
 * Tests for Designing Endpoints
 * Covered Endpoints:
 * - POST /projects/:projectId/design (Trigger Design)
 */
Deno.test({
  name: "Sync: Design flow (TriggerDesign -> ConceptDesigning)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  // 1. Setup Environment
  const [db, client] = await testDb();
  
  const ProjectLedger = concepts.ProjectLedger as any;
  const Planning = concepts.Planning as any;
  const Requesting = concepts.Requesting as any;
  const UserAuthenticating = concepts.UserAuthenticating as any;
  const UserSessioning = concepts.UserSessioning as any;
  const ConceptDesigning = concepts.ConceptDesigning as any;
  
  // Monkey-patch collections
  ProjectLedger.projects = db.collection("ProjectLedger.projects");
  Planning.plans = db.collection("Planning.plans");
  Requesting.requests = db.collection("Requesting.requests");
  Requesting.pending = new Map();
  UserAuthenticating.users = db.collection("UserAuthenticating.users");
  UserSessioning.sessions = db.collection("UserSessioning.sessions");
  ConceptDesigning.designs = db.collection("ConceptDesigning.designs");
  
  try {
    // 2. Register Syncs
    Engine.logging = Logging.VERBOSE;
    Engine.register(syncs);

    // 3. Create User, Session, and Project with Plan
    console.log("Setting up project state...");
    const email = "test@example.com";
    const password = "password123";
    
    // Register & Login
    const regResult = await UserAuthenticating.register({ email, password });
    if ("error" in regResult) throw new Error(regResult.error);
    const userId = regResult.user;
    
    const sessResult = await UserSessioning.create({ user: userId });
    const token = sessResult.accessToken;
    
    // Manually create Project and Plan (skipping Planning flow)
    const projectId = "test-project-id";
    await ProjectLedger.projects.insertOne({
        _id: projectId,
        owner: userId,
        name: "Test App",
        status: "planning_complete",
        createdAt: new Date()
    });

    const mockPlan = {
        summary: "A simple note app",
        entities: [{ name: "Note", properties: ["content"] }],
        user_flows: [],
        pages: [],
        technical_requirements: []
    };

    await Planning.plans.insertOne({
        _id: projectId,
        status: "complete",
        plan: mockPlan,
        createdAt: new Date()
    });
    
    // 4. Trigger Design Request
    console.log("Triggering Design request...");
    const inputs = {
      path: `/projects/${projectId}/design`,
      method: "POST",
      accessToken: token
    };
    
    const { request } = await Requesting.request(inputs);
    
    console.log("Waiting for response...");
    // Increase timeout for design agent
    const responseArray = await Requesting._awaitResponse({ request });
    const response = responseArray[0].response as any;
    
    console.log("Response received:", response);
    
    // 5. Verify Response
    assertEquals(response.status, "complete");
    assertExists(response.design);
    assertEquals(response.design.customConcepts.length > 0, true);
    
    // Verify ProjectLedger status
    const p = await ProjectLedger.projects.findOne({ _id: projectId });
    assertEquals(p.status, "design_complete");
    
    // Verify Design stored
    const d = await ConceptDesigning.designs.findOne({ _id: projectId });
    assertExists(d);
    assertEquals(d.status, "complete");

  } finally {
    await client.close();
  }
}
});

