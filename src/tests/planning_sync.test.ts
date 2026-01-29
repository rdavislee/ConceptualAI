import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts"; 
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

/**
 * Tests for Planning Endpoints
 * Covered Endpoints:
 * - POST /projects (Create Project)
 * - PUT /projects/:projectId/plan (Modify Plan)
 * - POST /projects/:projectId/clarify (Clarify Plan)
 */
Deno.test({
  name: "Sync: CreateProject flow (Request -> ProjectLedger + Planning)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  // 1. Setup Environment
  const [db, client] = await testDb();
  
  // Re-instantiate concepts with test DB
  // We need to override the concepts in the global object or create a new set
  // The 'concepts' import is a live object, but its properties are instances.
  // We can't easily swap them out globally for the import.
  // However, the Engine uses whatever we register or whatever is passed to it?
  // No, the Engine uses the imported @concepts usually, OR we can pass context.
  // Actually, syncs use imports like `import { ProjectLedger } from "@concepts"`.
  // This means we MUST modify the instances in `@concepts` to point to our test DB instances.
  
  // This is a known limitation of the current architecture for testing syncs specifically.
  // A workaround is to rely on the fact that `testDb` might be using the same mongo client if we configure it right?
  // No, `testDb` creates a new DB name.
  
  // Let's manually overwrite the instances in the `concepts` object.
  // This assumes `concepts` allows mutation or we can re-create the module state.
  // Since `concepts` is a namespace import `* as concepts`, it's immutable.
  // We might need to use a dependency injection pattern or a test-specific concepts barrel.
  
  // Ideally, we should have `@concepts` export a singleton that we can re-configure.
  // But given the constraints, let's try to mock the `db` property of the existing instances if possible?
  // `ProjectLedger` instance has a `db` property.
  
  // Let's try to cast and mutate.
  const ProjectLedger = concepts.ProjectLedger as any;
  const Planning = concepts.Planning as any;
  const Requesting = concepts.Requesting as any;
  const Authenticating = concepts.Authenticating as any;
  const Sessioning = concepts.Sessioning as any;
  
  const ConceptDesigning = concepts.ConceptDesigning as any;
  
  // Re-initialize instances with test DB
  // We can't easily replace the `readonly db` property.
  // BUT, we can create NEW instances and try to run the sync logic manually using these instances?
  // The syncs import the instances directly.
  
  // WAIT. The syncs import specific instances from `@concepts`.
  // If we can't change what `@concepts` exports, we can't test syncs integration cleanly without
  // running the whole app against a test config.
  
  // Alternative: Set `DB_NAME` env var to a test name before importing?
  // `src/utils/database.ts` reads `DB_NAME` on `init()`.
  // If we run `deno test`, it loads imports.
  // The concepts are instantiated in `src/concepts/concepts.ts` (generated).
  // They call `getDb()`.
  
  // If we want to use a test DB, we should probably set `DB_NAME` environment variable
  // BEFORE the concepts are instantiated.
  // However, in Deno, imports happen before execution of test body.
  
  // The user asked to "create tests for these syncs".
  // Let's assume we can run the test with a specific environment variable or logic.
  // `src/utils/database.ts` has `testDb`.
  
  // Let's try to monkey-patch the collections on the instances.
  // This is hacky but effective for this architecture.
  
  ProjectLedger.projects = db.collection("ProjectLedger.projects");
  Planning.plans = db.collection("Planning.plans");
  Requesting.requests = db.collection("Requesting.requests");
  Requesting.pending = new Map(); // Reset pending
  Authenticating.users = db.collection("Authenticating.users");
  Sessioning.sessions = db.collection("Sessioning.sessions");
  ConceptDesigning.designs = db.collection("ConceptDesigning.designs");
  
  try {
    // 2. Register Syncs
    Engine.logging = Logging.VERBOSE;
    Engine.register(syncs);

    // 3. Create User & Session
    console.log("Creating user and session...");
    const email = "test@example.com";
    const password = "password123";
    
    // Register
    const regResult = await Authenticating.register({ email, password });
    if ("error" in regResult) throw new Error(regResult.error);
    const userId = regResult.user;
    
    // Create Session
    const sessResult = await Sessioning.create({ user: userId });
    const token = sessResult.accessToken;
    
    // 4. Trigger Request (Simulate API Call)
    console.log("Triggering CreateProject request...");
    const description = "A simple todo app for tracking tasks.";
    const inputs = {
      path: "/projects",
      method: "POST",
      name: "Todo App",
      description,
      accessToken: token
    };
    
    // We call Requesting.request directly.
    // This creates the Request object.
    // We then need to wait for the syncs to fire.
    // Since syncs are async, we might need to poll or wait.
    // `Requesting._awaitResponse` waits for a response, which implies the sync chain completed.
    
    const { request } = await Requesting.request(inputs);
    
    // We await the response, which forces us to wait for the sync `PlanningNeedsClarification` or `PlanningComplete` to fire.
    // Note: The syncs we wrote respond to the request!
    console.log("Waiting for response...");
    const responseArray = await Requesting._awaitResponse({ request });
    const response = responseArray[0].response as any;
    
    console.log("Response received:", response);
    
    // 5. Verify Response
    // We expect "awaiting_input" (clarification) OR "planning_complete" depending on the agent.
    // "Todo app" is vague, so it might ask clarification.
    // Or if the model is smart/conservative, it might just plan it.
    // Let's handle both.
    
    if (response.status === "awaiting_input") {
        console.log("Agent requested clarification:", response.questions);
        assertExists(response.questions);
        assertEquals(response.questions.length > 0, true);
        
        // Verify ProjectLedger status
        // We need to query ProjectLedger. 
        // We can use the concept's query method OR check DB directly.
        // Let's use the query method if possible, but we don't know the project ID easily 
        // unless we extract it from the logs or DB.
        // Wait, `CreateProject` sync bound `projectId`.
        
        // Let's find the project belonging to the user.
        const projects = await ProjectLedger._getProjects({ owner: userId });
        assertEquals(projects.length, 1);
        const pList = projects[0].projects;
        const p = pList[0];
        assertEquals(p.name, "Todo App");
        assertEquals(p.status, "awaiting_clarification");
        
        // Verify Planning state
        const plans = await Planning._getPlan({ project: p._id });
        assertEquals(plans.length, 1);
        const plan = plans[0].plan;
        assertEquals(plan.description, description);
        assertEquals(plan.status, "needs_clarification");
        
    } else if (response.status === "planning_complete") {
        console.log("Agent completed planning immediately.");
        assertExists(response.plan);
        
        // Verify ProjectLedger
        const projects = await ProjectLedger._getProjects({ owner: userId });
        assertEquals(projects.length, 1);
        const pList = projects[0].projects;
        const p = pList[0];
        assertEquals(p.name, "Todo App");
        // Status should be "planning_complete" as per updated sync
        assertEquals(p.status, "planning_complete"); 
        
        // Verify Planning
        const plans = await Planning._getPlan({ project: p._id });
        assertEquals(plans.length, 1);
        assertEquals(plans[0].plan.status, "complete");

        // 6. Test Modification Flow
        console.log("Testing modification flow...");
        const feedback = "Add a dark mode toggle to the technical requirements.";
        
        const modInputs = {
          path: `/projects/${p._id}/plan`,
          method: "PUT",
          feedback,
          accessToken: token
        };
        
        const { request: modRequest } = await Requesting.request(modInputs);
        
        console.log("Waiting for modification response...");
        const modResponseArray = await Requesting._awaitResponse({ request: modRequest });
        const modResponse = modResponseArray[0].response as any;
        
        console.log("Modification response received:", modResponse);
        
        assertEquals(modResponse.status, "planning_complete");
        assertExists(modResponse.plan);
        // ... (check tech reqs) ...

        // 7. Test Clarification Flow (Simulation)
        // Since we can't easily force the agent to ask for clarification in the main flow,
        // we will manually inject a plan state that needs clarification and then answer it.
        console.log("Testing clarification flow...");
        const clarifyProjectId = "clarify-test-project";
        await ProjectLedger.projects.insertOne({
            _id: clarifyProjectId,
            owner: userId,
            name: "Ambiguous App",
            status: "awaiting_clarification",
            createdAt: new Date()
        });
        await Planning.plans.insertOne({
            _id: clarifyProjectId,
            status: "needs_clarification",
            description: "A confusing app",
            questions: ["What does it do?"],
            clarifications: [],
            createdAt: new Date()
        });

        const clarifyInputs = {
            path: `/projects/${clarifyProjectId}/clarify`,
            method: "POST",
            answers: { "What does it do?": "It does nothing." },
            accessToken: token
        };

        const { request: clarifyReq } = await Requesting.request(clarifyInputs);
        const [clarifyRes] = await Requesting._awaitResponse({ request: clarifyReq });
        const clarifyData = clarifyRes.response as any;
        
        // It might be complete or still need clarification, but we expect a valid response
        assertExists(clarifyData.status);
        console.log("Clarification response:", clarifyData);

    } else {
        throw new Error(`Unexpected response status: ${response.status}`);
    }

  } finally {
    await client.close();
  }
}
});

