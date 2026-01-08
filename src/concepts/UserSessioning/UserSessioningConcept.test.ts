import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import UserSessioningConcept from "./UserSessioningConcept.ts";

// Set JWT_SECRET for testing
Deno.env.set("JWT_SECRET", "test-secret-key-minimum-32-characters-long-12345");

Deno.test("UserSessioning: Create Session", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    const user = "user:123" as ID;

    // Create session
    const result = await sessionConcept.create({ user });
    assertNotEquals("error" in result, true, "Create session should succeed");
    const { accessToken, refreshToken } = result as {
      accessToken: string;
      refreshToken: string;
    };

    assertExists(accessToken, "Access token should exist");
    assertExists(refreshToken, "Refresh token should exist");
    assertEquals(typeof accessToken, "string", "Access token should be string");
    assertEquals(
      typeof refreshToken,
      "string",
      "Refresh token should be string",
    );

    // Verify session stored in database
    const sessions = await sessionConcept.sessions.find({ user }).toArray();
    assertEquals(sessions.length, 1, "Should have one session");
    assertEquals(sessions[0].status, "active", "Session should be active");
    assertEquals(sessions[0].user, user, "Session should belong to user");
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Get User from Access Token", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    const user = "user:456" as ID;

    // Create session
    const createResult = await sessionConcept.create({ user });
    const { accessToken } = createResult as {
      accessToken: string;
      refreshToken: string;
    };

    // Get user from access token
    const getUserResult = await sessionConcept._getUser({
      session: accessToken,
    });
    assertNotEquals(
      "error" in getUserResult[0],
      true,
      "Get user should succeed",
    );
    const [{ user: retrievedUser }] = getUserResult as Array<{ user: ID }>;
    assertEquals(retrievedUser, user, "Should return correct user");
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Refresh Token", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    const user = "user:789" as ID;

    // Create session
    const createResult = await sessionConcept.create({ user });
    const { refreshToken: oldRefreshToken } = createResult as {
      accessToken: string;
      refreshToken: string;
    };

    // Refresh token
    const refreshResult = await sessionConcept.refresh({
      refreshToken: oldRefreshToken,
    });
    assertNotEquals("error" in refreshResult, true, "Refresh should succeed");
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
      refreshResult as {
        accessToken: string;
        refreshToken: string;
      };

    assertExists(newAccessToken, "New access token should exist");
    assertExists(newRefreshToken, "New refresh token should exist");
    assertNotEquals(
      newRefreshToken,
      oldRefreshToken,
      "New refresh token should be different",
    );

    // Verify old session is revoked
    const oldSessions = await sessionConcept.sessions.find({
      user,
      status: "revoked",
    }).toArray();
    assertEquals(oldSessions.length, 1, "Old session should be revoked");

    // Verify new session is active
    const newSessions = await sessionConcept.sessions.find({
      user,
      status: "active",
    }).toArray();
    assertEquals(newSessions.length, 1, "New session should be active");
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Delete Session (Logout)", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    const user = "user:999" as ID;

    // Create session
    const createResult = await sessionConcept.create({ user });
    const { accessToken } = createResult as {
      accessToken: string;
      refreshToken: string;
    };

    // Delete session (logout)
    const deleteResult = await sessionConcept.delete({ session: accessToken });
    assertNotEquals("error" in deleteResult, true, "Delete should succeed");

    // Verify session is revoked
    const sessions = await sessionConcept.sessions.find({ user }).toArray();
    assertEquals(sessions.length, 1, "Should have one session");
    assertEquals(sessions[0].status, "revoked", "Session should be revoked");
    assertExists(sessions[0].revokedAt, "revokedAt should be set");

    // Verify access token no longer works
    const getUserResult = await sessionConcept._getUser({
      session: accessToken,
    });
    assertEquals(
      "error" in getUserResult[0],
      true,
      "Get user should fail after logout",
    );
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Delete Session by Refresh Token", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    const user = "user:111" as ID;

    // Create session
    const createResult = await sessionConcept.create({ user });
    const { refreshToken } = createResult as {
      accessToken: string;
      refreshToken: string;
    };

    // Delete session by refresh token
    const deleteResult = await sessionConcept.delete({ refreshToken });
    assertNotEquals("error" in deleteResult, true, "Delete should succeed");

    // Verify session is revoked
    const sessions = await sessionConcept.sessions.find({ user }).toArray();
    assertEquals(sessions[0].status, "revoked", "Session should be revoked");
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Delete Requires Token", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    // Try to delete without providing token
    const result = await sessionConcept.delete({});
    assertEquals("error" in result, true, "Should return error");
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Validate Refresh Token", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    const user = "user:222" as ID;

    // Create session
    const createResult = await sessionConcept.create({ user });
    const { refreshToken } = createResult as {
      accessToken: string;
      refreshToken: string;
    };

    // Validate refresh token
    const validateResult = await sessionConcept._validateRefreshToken({
      refreshToken,
    });
    assertNotEquals(
      "error" in validateResult[0],
      true,
      "Validate should succeed",
    );
    const [{ user: retrievedUser }] = validateResult as Array<{ user: ID }>;
    assertEquals(retrievedUser, user, "Should return correct user");
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Invalid Access Token", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    // Try to get user with invalid token
    const result = await sessionConcept._getUser({
      session: "invalid.token.here",
    });
    assertEquals("error" in result[0], true, "Should return error");
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Invalid Refresh Token", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    // Try to refresh with invalid token
    const result = await sessionConcept.refresh({
      refreshToken: "invalid.token.here",
    });
    assertEquals("error" in result, true, "Should return error");
  } finally {
    await client.close();
  }
});

Deno.test("UserSessioning: Refresh Token After Revocation", async () => {
  const [db, client] = await testDb();
  const sessionConcept = new UserSessioningConcept(db);

  try {
    const user = "user:333" as ID;

    // Create session
    const createResult = await sessionConcept.create({ user });
    const { refreshToken } = createResult as {
      accessToken: string;
      refreshToken: string;
    };

    // Revoke session
    await sessionConcept.delete({ refreshToken });

    // Try to refresh with revoked token
    const refreshResult = await sessionConcept.refresh({ refreshToken });
    assertEquals("error" in refreshResult, true, "Should return error");
  } finally {
    await client.close();
  }
});
