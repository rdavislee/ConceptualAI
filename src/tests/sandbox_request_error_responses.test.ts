import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: Sandbox spawn routes return explicit errors (no stall)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();

    const ProjectLedger = concepts.ProjectLedger as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;

    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");

    try {
      Engine.logging = Logging.VERBOSE;
      Engine.register(syncs);

      const { user } = await Authenticating.register({
        email: "sandbox-errors@test.com",
        password: "pw",
      });
      const { accessToken } = await Sessioning.create({ user });

      // 1) Unauthorized should never stall.
      {
        const { request } = await Requesting.request({
          path: "/projects/non-existent/design",
          method: "PUT",
          feedback: "x",
          accessToken: "bad-token",
          geminiKey: "k",
          geminiTier: "3",
        });
        const [res] = await Requesting._awaitResponse({ request });
        assertEquals((res.response as any).statusCode, 401);
      }

      // 2) Not found should return 404.
      {
        const { request } = await Requesting.request({
          path: "/projects/non-existent/implement",
          method: "POST",
          accessToken,
          geminiKey: "k",
          geminiTier: "3",
        });
        const [res] = await Requesting._awaitResponse({ request });
        assertEquals((res.response as any).statusCode, 404);
      }

      // 3) Invalid status should return 409 for routes with required stage.
      const projectId = "status-invalid-project";
      await ProjectLedger.projects.insertOne({
        _id: projectId,
        owner: user,
        name: "Invalid Stage",
        description: "test",
        status: "planning",
        autocomplete: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      {
        const { request } = await Requesting.request({
          path: `/projects/${projectId}/build`,
          method: "POST",
          accessToken,
          geminiKey: "k",
          geminiTier: "3",
        });
        const [res] = await Requesting._awaitResponse({ request });
        assertEquals((res.response as any).statusCode, 409);
        const project = await ProjectLedger.projects.findOne({ _id: projectId });
        assertEquals(project?.autocomplete, false);
      }
    } finally {
      await client.close();
    }
  },
});
