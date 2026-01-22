import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts"; 
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

/**
 * Tests for Implementing Endpoints
 * Covered Endpoints:
 * - POST /projects/:projectId/implement (Trigger Implementation)
 * - GET /projects/:projectId/implementations (Get Implementations)
 */
Deno.test({
  name: "Sync: Implementation flow (Design -> Implement)",
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
  const Implementing = concepts.Implementing as any;
  
  // Monkey-patch collections to use the test DB
  ProjectLedger.projects = db.collection("ProjectLedger.projects");
  Planning.plans = db.collection("Planning.plans");
  Requesting.requests = db.collection("Requesting.requests");
  Requesting.pending = new Map();
  UserAuthenticating.users = db.collection("UserAuthenticating.users");
  UserSessioning.sessions = db.collection("UserSessioning.sessions");
  ConceptDesigning.designs = db.collection("ConceptDesigning.designs");
  Implementing.implJobs = db.collection("Implementing.implJobs");
  
  try {
    // 2. Register Syncs
    Engine.logging = Logging.VERBOSE;
    Engine.register(syncs);

    // 3. Create User, Session, and Project with Plan
    console.log("Setting up project state...");
    const email = "dev@example.com";
    const password = "password123";
    
    // Register & Login
    const regResult = await UserAuthenticating.register({ email, password });
    if ("error" in regResult) throw new Error(regResult.error);
    const userId = regResult.user;
    
    const sessResult = await UserSessioning.create({ user: userId });
    const token = sessResult.accessToken;
    
    // Manually create Project
    const projectId = "impl-test-project";
    await ProjectLedger.projects.insertOne({
        _id: projectId,
        owner: userId,
        name: "Simple Story App",
        status: "planning_complete", // Start state for design
        createdAt: new Date()
    });

    // Manually insert a Plan (A simple app similar to Storying to test library retrieval or generation)
    // We use a plan that implies 'Posting' or similar to test library usage if possible, 
    // or a custom one to test generation.
    const mockPlan = {
        summary: "An app for sharing short text stories.",
        entities: [{ name: "Story", properties: ["content", "author"] }],
        user_flows: ["User creates story", "User views stories"],
        pages: ["Feed", "Create Story"],
        technical_requirements: []
    };

    await Planning.plans.insertOne({
        _id: projectId,
        status: "complete",
        plan: mockPlan,
        createdAt: new Date()
    });
    
    // 4. Trigger Design Request (Prerequisite)
    console.log("Triggering Design request...");
    const designInputs = {
      path: `/projects/${projectId}/design`,
      method: "POST",
      accessToken: token
    };
    
    const { request: designReq } = await Requesting.request(designInputs);
    
    console.log("Waiting for Design completion (this involves LLM)...");
    const designRespArray = await Requesting._awaitResponse({ request: designReq });
    const designResponse = designRespArray[0].response as any;
    
    assertEquals(designResponse.status, "complete");
    const design = designResponse.design;
    console.log("Design complete. Custom Concepts:", design.customConcepts.length, "Library Pulls:", design.libraryPulls.length);

    // 5. Trigger Implementation Request
    console.log("Triggering Implementation request...");
    const implInputs = {
        path: `/projects/${projectId}/implement`,
        method: "POST",
        accessToken: token
    };

    const { request: implReq } = await Requesting.request(implInputs);

    console.log("Waiting for Implementation completion (this involves LLM and Tests)...");
    // This might take longer, ensure test timeout is handled by Deno or external runner if needed
    const implRespArray = await Requesting._awaitResponse({ request: implReq });
    const implResponse = implRespArray[0].response as any;

    console.log("Implementation Response:", implResponse);

    // 6. Verify Implementation Response
    assertEquals(implResponse.status, "complete");
    assertExists(implResponse.implementations);
    
    // Check that we have implementations matching the design
    for (const custom of design.customConcepts) {
        assertExists(implResponse.implementations[custom.name]);
        assertEquals(implResponse.implementations[custom.name].status, "complete");
    }
    for (const pull of design.libraryPulls) {
        assertExists(implResponse.implementations[pull.libraryName]);
        assertEquals(implResponse.implementations[pull.libraryName].status, "complete");
    }

    // 7. Verify Project Status
    const p = await ProjectLedger.projects.findOne({ _id: projectId });
    assertEquals(p.status, "implemented");

    // 8. Verify GET /implementations
    console.log("Verifying GET /implementations...");
    const getInputs = {
        path: `/projects/${projectId}/implementations`,
        method: "GET",
        accessToken: token
    };
    const { request: getReq } = await Requesting.request(getInputs);
    const getRespArray = await Requesting._awaitResponse({ request: getReq });
    const getResponse = getRespArray[0].response as any;

    assertExists(getResponse.implementations);
    assertEquals(Object.keys(getResponse.implementations).length, Object.keys(implResponse.implementations).length);

  } finally {
    await client.close();
  }
}
});
