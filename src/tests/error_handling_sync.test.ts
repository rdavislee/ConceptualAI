import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts"; 
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

/**
 * Tests for API Error Handling
 * Covered Scenarios:
 * - GET /projects/:id/plan with invalid ID (404)
 */
Deno.test({
  name: "Sync: Error Handling (404/401/403)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    
    const ProjectLedger = concepts.ProjectLedger as any;
    const Planning = concepts.Planning as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const ConceptDesigning = concepts.ConceptDesigning as any;

    // Monkey-patch
    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Planning.plans = db.collection("Planning.plans");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    ConceptDesigning.designs = db.collection("ConceptDesigning.designs");

    try {
        Engine.logging = Logging.VERBOSE;
        Engine.register(syncs);

        // Setup User
        const { user } = await Authenticating.register({ email: "test@example.com", password: "pw" });
        const { accessToken } = await Sessioning.create({ user });

        // 1. Trigger POST /projects
        console.log("Triggering POST /projects");
        const { request: postReqId } = await Requesting.request({
            path: "/projects",
            method: "POST",
            name: "New App",
            description: "Desc",
            accessToken
        });

        // 2. Trigger GET /projects/WRONG_ID/plan
        const wrongId = "wrong-id-123";
        console.log(`Triggering GET /projects/${wrongId}/plan`);
        const { request: getReqId } = await Requesting.request({
            path: `/projects/${wrongId}/plan`,
            method: "GET",
            accessToken
        });

        // 3. Await GET response
        // Currently, without 404 handling, this should TIMEOUT (30s)
        console.log("Waiting for GET response...");
        const [getRes] = await Requesting._awaitResponse({ request: getReqId });
        const getData = getRes.response as any;
        
        console.log("GET Response:", getData);

        // 4. Assert 404
        assertEquals(getData.statusCode, 404);
        assertEquals(getData.error, "Project not found or access denied");

    } finally {
        await client.close();
    }
  }
});
