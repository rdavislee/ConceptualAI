import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";

Deno.test({
  name: "Sync: Auth Login",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Requesting = concepts.Requesting as any;

    // Monkey-patch collections
    Authenticating.users = db.collection("UserAuthenticating.users");
    Sessioning.sessions = db.collection("UserSessioning.sessions");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      // Setup: Create a user directly to test login against
      const email = "test@example.com";
      const password = "password123";
      
      // Seed the database with a user
      const regResult = await Authenticating.register({ email, password });
      if ("error" in regResult) throw new Error(regResult.error);
      const userId = regResult.user;

      // Test 1: Successful Login
      const loginInputs = {
        path: "/auth/login",
        method: "POST",
        email,
        password,
      };

      const { request: req1 } = await Requesting.request(loginInputs);
      const [res1] = await Requesting._awaitResponse({ request: req1 });
      const data1 = res1.response as any;

      assertExists(data1.accessToken);
      assertExists(data1.refreshToken);
      assertEquals(data1.user, userId);

      // Test 2: Invalid Password
      const failInputs = {
        path: "/auth/login",
        method: "POST",
        email,
        password: "wrongpassword",
      };

      const { request: req2 } = await Requesting.request(failInputs);
      const [res2] = await Requesting._awaitResponse({ request: req2 });
      const data2 = res2.response as any;

      assertEquals(data2.statusCode, 401);
      assertExists(data2.error);

    } finally {
      await client.close();
    }
  },
});