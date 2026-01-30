import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

/**
 * Tests for Authentication Endpoints
 * Covered Endpoints:
 * - POST /auth/register
 * - POST /auth/login
 * - POST /auth/refresh
 * - POST /auth/logout
 * - POST /auth/_getUser
 */
Deno.test({
  name: "Sync: Authentication Flow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Requesting = concepts.Requesting as any;
    const Profiling = concepts.Profiling as any;

    // Monkey-patch
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    // Profiling uses profiles collection
    Profiling.profiles = db.collection("Profiling.profiles");

    try {
        Engine.logging = Logging.VERBOSE;
        Engine.register(syncs);

        const email = "auth_test@example.com";
        const password = "password123";
        const username = "authtest";

        // 1. Register
        console.log("Testing POST /auth/register");
        const regInputs = {
            path: "/auth/register",
            method: "POST",
            email,
            password,
            username,
            name: "Auth Test User"
        };
        const { request: regReq } = await Requesting.request(regInputs);
        const [regRes] = await Requesting._awaitResponse({ request: regReq });
        const regData = regRes.response as any;

        assertExists(regData.accessToken);
        assertExists(regData.refreshToken);
        assertExists(regData.user);
        const accessToken = regData.accessToken;
        const refreshToken = regData.refreshToken;

        // 2. Login
        console.log("Testing POST /auth/login");
        const loginInputs = {
            path: "/auth/login",
            method: "POST",
            email,
            password
        };
        const { request: loginReq } = await Requesting.request(loginInputs);
        const [loginRes] = await Requesting._awaitResponse({ request: loginReq });
        const loginData = loginRes.response as any;

        assertExists(loginData.accessToken);
        assertEquals(loginData.user, regData.user);

        // 3. Get User (Validate Session)
        console.log("Testing POST /auth/_getUser");
        const getUserInputs = {
            path: "/auth/_getUser",
            method: "POST",
            accessToken
        };
        const { request: getUserReq } = await Requesting.request(getUserInputs);
        const [getUserRes] = await Requesting._awaitResponse({ request: getUserReq });
        const getUserData = getUserRes.response as any;

        assertEquals(getUserData.user, regData.user);

        // 4. Refresh Token
        console.log("Testing POST /auth/refresh");
        const refreshInputs = {
            path: "/auth/refresh",
            method: "POST",
            refreshToken
        };
        const { request: refreshReq } = await Requesting.request(refreshInputs);
        const [refreshRes] = await Requesting._awaitResponse({ request: refreshReq });
        const refreshData = refreshRes.response as any;

        assertExists(refreshData.accessToken);

        // 5. Logout
        console.log("Testing POST /auth/logout");
        const logoutInputs = {
            path: "/auth/logout",
            method: "POST",
            accessToken: refreshData.accessToken // Use new token
        };
        const { request: logoutReq } = await Requesting.request(logoutInputs);
        const [logoutRes] = await Requesting._awaitResponse({ request: logoutReq });
        const logoutData = logoutRes.response as any;

        assertEquals(logoutData.status, "logged_out");

    } finally {
        await client.close();
    }
  }
});
