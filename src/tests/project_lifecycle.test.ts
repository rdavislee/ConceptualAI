import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts"; 
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

/**
 * Tests for Project Lifecycle (Create, Delete)
 * Covered Endpoints:
 * - DELETE /projects/:projectId
 */
Deno.test({
  name: "Sync: Delete Project Flow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    
    const ProjectLedger = concepts.ProjectLedger as any;
    const Planning = concepts.Planning as any;
    const ConceptDesigning = concepts.ConceptDesigning as any;
    const Sandboxing = concepts.Sandboxing as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;

    // Monkey-patch
    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Planning.plans = db.collection("Planning.plans");
    ConceptDesigning.designs = db.collection("ConceptDesigning.designs");
    Sandboxing.sandboxes = db.collection("Sandboxing.sandboxes");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");

    try {
        Engine.logging = Logging.VERBOSE;
        Engine.register(syncs);

        // Setup User
        const { user } = await Authenticating.register({ email: "lifecycle@test.com", password: "pw" });
        const { accessToken } = await Sessioning.create({ user });

        // 1. Create Project manually (to ensure it exists)
        const projectId = "test-project-del";
        await ProjectLedger.projects.insertOne({
            _id: projectId,
            owner: user,
            name: "To Delete",
            description: "delete lifecycle fixture",
            status: "planning",
            autocomplete: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await Planning.plans.insertOne({
            _id: projectId,
            status: "processing",
            createdAt: new Date(),
            clarifications: []
        });
        await ConceptDesigning.designs.insertOne({
            _id: projectId,
            status: "complete",
            createdAt: new Date(),
            plan: {},
            libraryPulls: [],
            customConcepts: []
        });
        await Sandboxing.sandboxes.insertOne({
            _id: "sandbox-project-del",
            userId: user,
            projectId,
            containerId: "sandbox-sandbox-project-del",
            endpoint: "ephemeral",
            status: "ready",
            createdAt: new Date(),
            lastActiveAt: new Date(),
        });

        // 2. Trigger DELETE /projects/:projectId
        console.log(`Triggering DELETE /projects/${projectId}`);
        const { request: delReqId } = await Requesting.request({
            path: `/projects/${projectId}`,
            method: "DELETE",
            accessToken
        });

        // 3. Await Response
        console.log("Waiting for DELETE response...");
        const [delRes] = await Requesting._awaitResponse({ request: delReqId });
        const delData = delRes.response as any;
        
        console.log("DELETE Response:", delData);

        // 4. Assert Success
        assertEquals(delData.status, "deleted");

        // 5. Verify Deletion in DB
        const p = await ProjectLedger.projects.findOne({ _id: projectId });
        assertEquals(p, null);

        const pl = await Planning.plans.findOne({ _id: projectId });
        assertEquals(pl, null);

        const d = await ConceptDesigning.designs.findOne({ _id: projectId });
        assertEquals(d, null);

        const sandbox = await Sandboxing.sandboxes.findOne({ _id: "sandbox-project-del" });
        assertExists(sandbox);
        assertEquals(sandbox.status, "terminated");

    } finally {
        await client.close();
    }
  }
});
