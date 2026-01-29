import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: List Tasks",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Requesting = concepts.Requesting as any;
    const Sessioning = concepts.Sessioning as any;
    const Todo = concepts.Todo as any;

    // Monkey-patch collections
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Todo.tasks = db.collection("Todo.tasks");

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      // 1. Setup Users and Session
      const userA = freshID();
      const userB = freshID();

      // Create session for User A
      const { accessToken } = await Sessioning.create({ user: userA });

      // 2. Create Tasks
      // User A's tasks
      await Todo.createTask({ owner: userA, description: "Buy milk" });
      await Todo.createTask({ owner: userA, description: "Walk the dog" });
      
      // User B's task (should not be seen by User A)
      await Todo.createTask({ owner: userB, description: "Secret mission" });

      // 3. Test GET /todos (Success)
      console.log("Testing GET /todos for User A");
      const listReqInput = {
        path: "/todos",
        method: "GET",
        accessToken,
      };
      const { request: listReq } = await Requesting.request(listReqInput);
      const [listRes] = await Requesting._awaitResponse({ request: listReq });
      const listData = listRes.response as any;

      assertExists(listData.tasks);
      assertEquals(Array.isArray(listData.tasks), true);
      assertEquals(listData.tasks.length, 2);
      
      const descriptions = listData.tasks.map((t: any) => t.description).sort();
      assertEquals(descriptions, ["Buy milk", "Walk the dog"]);

      // 4. Test GET /todos (Unauthorized)
      console.log("Testing GET /todos with invalid token");
      const invalidReqInput = {
        path: "/todos",
        method: "GET",
        accessToken: "invalid_token",
      };
      const { request: invalidReq } = await Requesting.request(invalidReqInput);
      const [invalidRes] = await Requesting._awaitResponse({ request: invalidReq });
      const invalidData = invalidRes.response as any;

      assertEquals(invalidData.error, "Unauthorized");

    } finally {
      await client.close();
    }
  },
});