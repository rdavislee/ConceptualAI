import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: Reject tier 0 sandbox request before provisioning",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();

    const ProjectLedger = concepts.ProjectLedger as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Sandboxing = concepts.Sandboxing as any;

    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Sandboxing.sandboxes = db.collection("Sandboxing.sandboxes");

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      const { user } = await Authenticating.register({
        email: "tier0@example.com",
        password: "password123",
      });
      const { accessToken } = await Sessioning.create({ user });

      const { request } = await Requesting.request({
        path: "/projects",
        method: "POST",
        name: "Tier Zero App",
        description: "Should be rejected before provisioning.",
        accessToken,
        geminiKey: "test-key",
        geminiTier: "0",
      });

      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertEquals(response.statusCode, 400);
      assertEquals(
        response.error,
        "Gemini tier 0/free is unsupported for sandbox pipeline requests.",
      );

      const projectCount = await ProjectLedger.projects.countDocuments({});
      const sandboxCount = await Sandboxing.sandboxes.countDocuments({});
      assertEquals(projectCount, 0);
      assertEquals(sandboxCount, 0);
    } finally {
      await client.close();
    }
  },
});
