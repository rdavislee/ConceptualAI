import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: Create Task (POST /todos)",
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

        // Setup: Create a user and a session directly
        const userId = freshID();
        const { accessToken } = await Sessioning.create({ user: userId });

        // 1. Test Success: Create Task
        console.log("Testing POST /todos (Success)");
        const description = "Buy milk";
        const input = {
            path: "/todos",
            method: "POST",
            accessToken,
            description
        };

        const { request: reqId } = await Requesting.request(input);
        const [response] = await Requesting._awaitResponse({ request: reqId });
        const resData = response.response as any;

        assertExists(resData.task);
        
        // Verify in DB
        const taskDoc = await Todo.tasks.findOne({ _id: resData.task });
        assertExists(taskDoc);
        assertEquals(taskDoc.description, description);
        assertEquals(taskDoc.owner, userId);
        assertEquals(taskDoc.isCompleted, false);

        // 2. Test Failure: Unauthorized (Invalid Token)
        console.log("Testing POST /todos (Unauthorized)");
        const invalidInput = {
            path: "/todos",
            method: "POST",
            accessToken: "invalid_token",
            description: "This should fail"
        };

        const { request: reqId2 } = await Requesting.request(invalidInput);
        const [response2] = await Requesting._awaitResponse({ request: reqId2 });
        const resData2 = response2.response as any;

        assertEquals(resData2.statusCode, 401);
        assertEquals(resData2.error, "Unauthorized");

        // 3. Test Failure: Validation Error (Empty Description)
        console.log("Testing POST /todos (Validation Error)");
        const emptyInput = {
            path: "/todos",
            method: "POST",
            accessToken,
            description: ""
        };

        const { request: reqId3 } = await Requesting.request(emptyInput);
        const [response3] = await Requesting._awaitResponse({ request: reqId3 });
        const resData3 = response3.response as any;

        assertEquals(resData3.statusCode, 400);
        assertExists(resData3.error);

    } finally {
        await client.close();
    }
  }
});