import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";

Deno.test({
  name: "Sync: Auth Register",
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

        const email = "test@example.com";
        const password = "password123";

        // 1. Test Successful Registration
        const { request: req1 } = await Requesting.request({
            path: "/auth/register",
            method: "POST",
            email,
            password
        });

        const [res1] = await Requesting._awaitResponse({ request: req1 });
        const data1 = res1.response as any;

        assertExists(data1.user, "User ID should be returned");
        assertExists(data1.accessToken, "Access token should be returned");
        assertExists(data1.refreshToken, "Refresh token should be returned");

        // 2. Test Duplicate Email Registration
        const { request: req2 } = await Requesting.request({
            path: "/auth/register",
            method: "POST",
            email,
            password
        });

        const [res2] = await Requesting._awaitResponse({ request: req2 });
        const data2 = res2.response as any;

        assertEquals(data2.statusCode, 409, "Should return 409 Conflict");
        assertEquals(data2.error, "Email already exists", "Should return correct error message");

    } finally {
        await client.close();
    }
  }
});