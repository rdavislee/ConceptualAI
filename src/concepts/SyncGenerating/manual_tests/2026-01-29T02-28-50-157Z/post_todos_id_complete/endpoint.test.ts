import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: Complete Task Endpoint",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Requesting = concepts.Requesting as any;
    const Todo = concepts.Todo as any;

    // Monkey-patch concepts with test DB collections
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Todo.tasks = db.collection("Todo.tasks");

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      // 1. Setup: Create a task directly
      const ownerId = "user_123";
      const description = "Finish the project";
      const createResult = await Todo.createTask({ owner: ownerId, description });
      
      // Handle potential error in creation (though unlikely in test)
      if ('error' in createResult) {
        throw new Error(`Failed to create task: ${createResult.error}`);
      }
      const taskId = createResult.task;
      assertExists(taskId);

      // Verify initial state
      const initialTasks = await Todo.tasks.find({ _id: taskId }).toArray();
      assertEquals(initialTasks[0].isCompleted, false);

      // 2. Test: Complete the task via API
      console.log(`Testing POST /todos/${taskId}/complete`);
      const inputs = {
        path: `/todos/${taskId}/complete`,
        method: "POST",
      };

      const { request } = await Requesting.request(inputs);
      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      // 3. Assertions
      assertEquals(response.ok, true);

      // Verify DB state
      const updatedTasks = await Todo.tasks.find({ _id: taskId }).toArray();
      assertEquals(updatedTasks[0].isCompleted, true);

      // 4. Test: Error case (Non-existent task)
      console.log("Testing POST /todos/non-existent-id/complete");
      const errorInputs = {
        path: "/todos/non-existent-id/complete",
        method: "POST",
      };

      const { request: errorReq } = await Requesting.request(errorInputs);
      const [errorResFrame] = await Requesting._awaitResponse({ request: errorReq });
      const errorResponse = errorResFrame.response as any;

      assertExists(errorResponse.error);
      assertEquals(errorResponse.statusCode, 404);

    } finally {
      await client.close();
    }
  },
});