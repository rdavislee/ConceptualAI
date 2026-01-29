import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: Delete Task",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Requesting = concepts.Requesting as any;
    const Todo = concepts.Todo as any;

    // Monkey-patch collections
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Todo.tasks = db.collection("Todo.tasks");

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      // 1. Setup: Create a task to delete
      const ownerId = freshID();
      const description = "Task to be deleted";
      const createResult = await Todo.createTask({ owner: ownerId, description });
      
      // Handle potential error in creation (though unlikely in test)
      if ('error' in createResult) {
        throw new Error(`Failed to create task: ${createResult.error}`);
      }
      const taskId = createResult.task;
      assertExists(taskId, "Task ID should exist after creation");

      // Verify task exists in DB
      const taskInDb = await Todo.tasks.findOne({ _id: taskId });
      assertExists(taskInDb, "Task should be in DB before delete");

      // 2. Execute: Send Delete Request
      console.log(`Testing POST /todos/${taskId}/delete`);
      const deleteInputs = {
        path: `/todos/${taskId}/delete`,
        method: "POST",
      };

      const { request: deleteReq } = await Requesting.request(deleteInputs);
      const [deleteRes] = await Requesting._awaitResponse({ request: deleteReq });
      const deleteData = deleteRes.response as any;

      // 3. Verify: Response
      assertEquals(deleteData.success, true);

      // 4. Verify: Task is gone from DB
      const taskInDbAfter = await Todo.tasks.findOne({ _id: taskId });
      assertEquals(taskInDbAfter, null, "Task should be removed from DB");

      // 5. Test Error Case: Try to delete non-existent task
      console.log("Testing delete on non-existent task");
      const fakeId = freshID();
      const failInputs = {
        path: `/todos/${fakeId}/delete`,
        method: "POST",
      };
      const { request: failReq } = await Requesting.request(failInputs);
      const [failRes] = await Requesting._awaitResponse({ request: failReq });
      const failData = failRes.response as any;

      assertExists(failData.error);
      assertEquals(failData.error, "Task not found");

    } finally {
      await client.close();
    }
  },
});