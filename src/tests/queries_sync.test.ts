import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

/**
 * Tests for Data Retrieval Endpoints
 * Covered Endpoints:
 * - GET /projects
 * - GET /projects/:projectId
 * - GET /projects/:projectId/plan
 * - GET /projects/:projectId/design
 */
Deno.test({
  name: "Sync: Query Endpoints",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    
    const ProjectLedger = concepts.ProjectLedger as any;
    const Planning = concepts.Planning as any;
    const ConceptDesigning = concepts.ConceptDesigning as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;

    // Monkey-patch
    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Planning.plans = db.collection("Planning.plans");
    ConceptDesigning.designs = db.collection("ConceptDesigning.designs");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");

    try {
        Engine.logging = Logging.VERBOSE;
        Engine.register(syncs);

        // Setup User
        const email = "query_test@example.com";
        const password = "password123";
        // Directly create user/session to skip auth sync overhead
        const regResult = await Authenticating.register({ email, password });
        const user = regResult.user;
        const sessResult = await Sessioning.create({ user });
        const accessToken = sessResult.accessToken;

        // Setup Project, Plan, Design
        const projectId = "query-test-project";
        await ProjectLedger.projects.insertOne({ 
            _id: projectId, 
            owner: user, 
            name: "Test Project", 
            description: "A test project",
            status: "design_complete",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await Planning.plans.insertOne({ 
            _id: projectId, 
            status: "complete", 
            plan: { summary: "test plan" },
            createdAt: new Date()
        });
        await ConceptDesigning.designs.insertOne({ 
            _id: projectId, 
            status: "complete", 
            design: { concepts: [] },
            createdAt: new Date()
        });

        // 1. GET /projects
        console.log("Testing GET /projects");
        const { request: req1 } = await Requesting.request({ path: "/projects", method: "GET", accessToken });
        const [res1] = await Requesting._awaitResponse({ request: req1 });
        const data1 = res1.response as any;
        assertExists(data1.projects);
        assertEquals(data1.projects.length, 1);
        assertEquals(data1.projects[0]._id, projectId);
        assertEquals(data1.projects[0].autocomplete, false);

        // 2. GET /projects/:projectId
        console.log("Testing GET /projects/:projectId");
        const { request: req2 } = await Requesting.request({ path: `/projects/${projectId}`, method: "GET", accessToken });
        const [res2] = await Requesting._awaitResponse({ request: req2 });
        const data2 = res2.response as any;
        assertExists(data2.project);
        assertEquals(data2.project._id, projectId);
        assertEquals(data2.project.autocomplete, false);

        // 3. GET /projects/:projectId/plan
        console.log("Testing GET /projects/:projectId/plan");
        const { request: req3 } = await Requesting.request({ path: `/projects/${projectId}/plan`, method: "GET", accessToken });
        const [res3] = await Requesting._awaitResponse({ request: req3 });
        const data3 = res3.response as any;
        assertExists(data3.plan);
        assertEquals(data3.plan.summary, "test plan");

        // 4. GET /projects/:projectId/design
        console.log("Testing GET /projects/:projectId/design");
        const { request: req4 } = await Requesting.request({ path: `/projects/${projectId}/design`, method: "GET", accessToken });
        const [res4] = await Requesting._awaitResponse({ request: req4 });
        const data4 = res4.response as any;
        assertExists(data4.design);
        assertEquals(data4.design.concepts.length, 0);

    } finally {
        await client.close();
    }
  }
});
