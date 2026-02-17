import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import AuthenticatingConcept from "./AuthenticatingConcept.ts";

const emailA = "alice@example.com";
const passwordA = "password123";
const emailB = "bob@example.com";
const passwordB = "securepass456";

const mongoTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });

mongoTest("Principle: user registers then logs in with credentials", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing principle: register -> login flow");

    // 1. User registers with email and password
    console.log(`Registering user: ${emailA}`);
    const registerResult = await auth.register({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in registerResult,
      false,
      "Registration should succeed for new email",
    );
    assertExists(
      "user" in registerResult ? registerResult.user : null,
      "Registration should return a user ID",
    );
    const { user: userIdA } = registerResult as { user: ID };
    console.log(`Registered user ID: ${userIdA}`);

    // 2. User can login with correct credentials
    console.log(`Logging in user: ${emailA}`);
    const loginResult = await auth.login({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in loginResult,
      false,
      "Login should succeed with correct credentials",
    );
    const { user: loggedInUser } = loginResult as { user: ID };
    assertEquals(
      loggedInUser,
      userIdA,
      "Login should return the same user ID as registration",
    );
    console.log(`Login successful, user ID: ${loggedInUser}`);

    // 3. Login fails with wrong password
    console.log(`Attempting login with wrong password for: ${emailA}`);
    const wrongPasswordResult = await auth.login({
      email: emailA,
      password: "wrongpassword",
    });
    assertEquals(
      "error" in wrongPasswordResult,
      true,
      "Login should fail with incorrect password",
    );
    if ("error" in wrongPasswordResult) {
      assertEquals(
        wrongPasswordResult.error,
        "Invalid email or password",
        "Error message should be generic for security",
      );
      console.log(`Login correctly rejected with wrong password`);
    }

    // 4. Login fails with non-existent email
    console.log(`Attempting login with non-existent email`);
    const wrongEmailResult = await auth.login({
      email: "nonexistent@example.com",
      password: passwordA,
    });
    assertEquals(
      "error" in wrongEmailResult,
      true,
      "Login should fail with non-existent email",
    );
    if ("error" in wrongEmailResult) {
      assertEquals(
        wrongEmailResult.error,
        "Invalid email or password",
        "Error message should be generic for security",
      );
      console.log(`Login correctly rejected with non-existent email`);
    }

    console.log(
      "Principle trace complete: registration and authentication flow verified",
    );
  } finally {
    await client.close();
  }
});

mongoTest("Action: register requires unique email", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing register action: unique email requirement");

    // First registration should succeed
    console.log(`Registering first user: ${emailA}`);
    const firstRegister = await auth.register({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in firstRegister,
      false,
      "First registration should succeed",
    );
    console.log("First registration successful");

    // Duplicate registration should fail
    console.log(`Attempting duplicate registration: ${emailA}`);
    const duplicateRegister = await auth.register({
      email: emailA,
      password: "differentpassword",
    });
    assertEquals(
      "error" in duplicateRegister,
      true,
      "Duplicate email registration should fail",
    );
    if ("error" in duplicateRegister) {
      assertEquals(
        duplicateRegister.error,
        "Email already exists",
        "Error message should indicate email conflict",
      );
      console.log("Duplicate registration correctly rejected");
    }

    // Verify effect: only one user exists with this email
    const userQuery = await auth._getUserByEmail({ email: emailA });
    assertEquals(
      userQuery.length,
      1,
      "Only one user should exist with the email",
    );
    console.log("Requirement verified: unique email enforced");
  } finally {
    await client.close();
  }
});

mongoTest("Action: register effects - creates user with hashed password", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing register action: effects verification");

    // Register a new user
    console.log(`Registering user: ${emailB}`);
    const registerResult = await auth.register({
      email: emailB,
      password: passwordB,
    });
    assertEquals(
      "error" in registerResult,
      false,
      "Registration should succeed",
    );
    const { user: userId } = registerResult as { user: ID };
    console.log(`Registered user ID: ${userId}`);

    // Verify effect: user can be queried by email
    const userQuery = await auth._getUserByEmail({ email: emailB });
    assertEquals(
      userQuery.length,
      1,
      "User should be retrievable after registration",
    );
    assertEquals(
      userQuery[0].user,
      userId,
      "Queried user ID should match registered user ID",
    );
    console.log("Effect verified: user created and retrievable");

    // Verify effect: persisted password hash uses hardened scrypt format.
    const persisted = await auth.users.findOne({ _id: userId });
    assertExists(persisted, "User document should be persisted");
    assertNotEquals(
      persisted.passwordHash,
      passwordB,
      "Password should never be stored in plaintext",
    );
    assertEquals(
      persisted.passwordHash.startsWith("scrypt$"),
      true,
      "Password hash should use scrypt format",
    );

    // Verify effect: password is hashed (user can login with original password)
    const loginResult = await auth.login({
      email: emailB,
      password: passwordB,
    });
    assertEquals(
      "error" in loginResult,
      false,
      "User should be able to login with original password",
    );
    const { user: loggedInUser } = loginResult as { user: ID };
    assertEquals(
      loggedInUser,
      userId,
      "Login should return the same user ID",
    );
    console.log(
      "Effect verified: password hash allows successful authentication",
    );
  } finally {
    await client.close();
  }
});

mongoTest("Action: login requires correct username and password", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing login action: requirements verification");

    // Register a user first
    console.log(`Registering user: ${emailA}`);
    const registerResult = await auth.register({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in registerResult,
      false,
      "Registration should succeed",
    );
    const { user: userId } = registerResult as { user: ID };
    console.log(`Registered user ID: ${userId}`);

    // Test: login with correct credentials should succeed
    console.log(`Logging in with correct credentials`);
    const correctLogin = await auth.login({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in correctLogin,
      false,
      "Login with correct credentials should succeed",
    );
    const { user: loggedInUser } = correctLogin as { user: ID };
    assertEquals(
      loggedInUser,
      userId,
      "Login should return the registered user ID",
    );
    console.log("Requirement met: correct credentials allow login");

    // Test: login with wrong password should fail
    console.log(`Attempting login with wrong password`);
    const wrongPasswordLogin = await auth.login({
      email: emailA,
      password: "wrongpassword",
    });
    assertEquals(
      "error" in wrongPasswordLogin,
      true,
      "Login with wrong password should fail",
    );
    if ("error" in wrongPasswordLogin) {
      assertEquals(
        wrongPasswordLogin.error,
        "Invalid email or password",
        "Error message should be generic",
      );
      console.log("Requirement enforced: wrong password rejected");
    }

    // Test: login with non-existent email should fail
    console.log(`Attempting login with non-existent email`);
    const wrongEmailLogin = await auth.login({
      email: "nonexistent@example.com",
      password: passwordA,
    });
    assertEquals(
      "error" in wrongEmailLogin,
      true,
      "Login with non-existent email should fail",
    );
    if ("error" in wrongEmailLogin) {
      assertEquals(
        wrongEmailLogin.error,
        "Invalid email or password",
        "Error message should be generic",
      );
      console.log("Requirement enforced: non-existent email rejected");
    }
  } finally {
    await client.close();
  }
});

mongoTest("Action: login effects - returns user ID on success", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing login action: effects verification");

    // Register a user
    console.log(`Registering user: ${emailB}`);
    const registerResult = await auth.register({
      email: emailB,
      password: passwordB,
    });
    assertEquals(
      "error" in registerResult,
      false,
      "Registration should succeed",
    );
    const { user: registeredUserId } = registerResult as { user: ID };
    console.log(`Registered user ID: ${registeredUserId}`);

    // Login and verify effect: returns the correct user ID
    console.log(`Logging in user: ${emailB}`);
    const loginResult = await auth.login({
      email: emailB,
      password: passwordB,
    });
    assertEquals(
      "error" in loginResult,
      false,
      "Login should succeed",
    );
    const { user: loggedInUserId } = loginResult as { user: ID };
    assertEquals(
      loggedInUserId,
      registeredUserId,
      "Login should return the same user ID as registration",
    );
    console.log(`Effect verified: login returns user ID ${loggedInUserId}`);
  } finally {
    await client.close();
  }
});

mongoTest("Query: _getUserByEmail returns user when exists", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing query: _getUserByEmail");

    // Register a user
    console.log(`Registering user: ${emailA}`);
    const registerResult = await auth.register({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in registerResult,
      false,
      "Registration should succeed",
    );
    const { user: userId } = registerResult as { user: ID };
    console.log(`Registered user ID: ${userId}`);

    // Query for existing user
    console.log(`Querying for user: ${emailA}`);
    const userQuery = await auth._getUserByEmail({ email: emailA });
    assertEquals(
      userQuery.length,
      1,
      "Query should return exactly one result for existing user",
    );
    assertEquals(
      userQuery[0].user,
      userId,
      "Queried user ID should match registered user ID",
    );
    console.log(`Query successful: found user ID ${userQuery[0].user}`);

    // Query for non-existent user
    console.log(`Querying for non-existent user`);
    const nonExistentQuery = await auth._getUserByEmail({
      email: "nonexistent@example.com",
    });
    assertEquals(
      nonExistentQuery.length,
      0,
      "Query should return empty array for non-existent user",
    );
    console.log("Query correctly returns empty array for non-existent user");
  } finally {
    await client.close();
  }
});

mongoTest("Action: resetPassword updates password and allows login with new password", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing resetPassword action");

    // 1. Register user
    await auth.register({ email: emailA, password: passwordA });

    // 2. Reset with wrong old password should fail
    const newPassword = "newpassword789";
    const wrongResetResult = await auth.resetPassword({
      email: emailA,
      oldPassword: "wrong-old-password",
      newPassword,
    });
    assertEquals(
      "error" in wrongResetResult,
      true,
      "Reset password should fail with incorrect old password",
    );
    if ("error" in wrongResetResult) {
      assertEquals(
        wrongResetResult.error,
        "Invalid email or password",
        "Error should be generic for invalid credentials",
      );
    }

    // 3. Login with old password should still work after failed reset
    const stillOldLogin = await auth.login({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in stillOldLogin,
      false,
      "Old password should still work after failed reset",
    );

    // 4. Reset with correct old password should succeed
    const resetResult = await auth.resetPassword({
      email: emailA,
      oldPassword: passwordA,
      newPassword,
    });
    assertEquals(
      "ok" in resetResult,
      true,
      "Reset password should succeed with correct old password",
    );

    // 5. Login with old password should fail
    const oldLogin = await auth.login({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in oldLogin,
      true,
      "Old password should no longer work",
    );

    // 6. Login with new password should succeed
    const newLogin = await auth.login({
      email: emailA,
      password: newPassword,
    });
    assertEquals(
      "error" in newLogin,
      false,
      "New password should work",
    );
    console.log("resetPassword verified");
  } finally {
    await client.close();
  }
});

mongoTest("Action: deleteAuthentication removes user by email", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing deleteAuthentication success case");

    const registerResult = await auth.register({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in registerResult,
      false,
      "Registration should succeed before deletion",
    );

    const deleteResult = await auth.deleteAuthentication({
      email: emailA,
    });
    assertEquals(
      "ok" in deleteResult,
      true,
      "Deletion should succeed for an existing email",
    );

    const userQuery = await auth._getUserByEmail({ email: emailA });
    assertEquals(
      userQuery.length,
      0,
      "Deleted user should not be returned by query",
    );

    const loginResult = await auth.login({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in loginResult,
      true,
      "Deleted user should not be able to login",
    );
    if ("error" in loginResult) {
      assertEquals(loginResult.error, "Invalid email or password");
    }

    const registerAgain = await auth.register({
      email: emailA,
      password: passwordA,
    });
    assertEquals(
      "error" in registerAgain,
      false,
      "Same email should be reusable after deletion",
    );
  } finally {
    await client.close();
  }
});

mongoTest("Action: deleteAuthenticationByUser removes user by ID", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    const registerResult = await auth.register({
      email: emailA,
      password: passwordA,
    });
    assertEquals("error" in registerResult, false);
    const { user: userId } = registerResult as { user: ID };

    const deleteResult = await auth.deleteAuthenticationByUser({ user: userId });
    assertEquals("ok" in deleteResult, true);

    const userQuery = await auth._getUserByEmail({ email: emailA });
    assertEquals(userQuery.length, 0);

    const loginResult = await auth.login({
      email: emailA,
      password: passwordA,
    });
    assertEquals("error" in loginResult, true);
  } finally {
    await client.close();
  }
});

mongoTest("Action: deleteAuthenticationByUser requires existing user", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    const deleteResult = await auth.deleteAuthenticationByUser({
      user: "nonexistent-user-id" as ID,
    });
    assertEquals("error" in deleteResult, true);
    if ("error" in deleteResult) {
      assertEquals(deleteResult.error, "User not found");
    }
  } finally {
    await client.close();
  }
});

mongoTest("Action: deleteAuthentication requires existing email", async () => {
  const [db, client] = await testDb();
  const auth = new AuthenticatingConcept(db);
  try {
    console.log("Testing deleteAuthentication existing-email requirement");

    await auth.register({
      email: emailB,
      password: passwordB,
    });

    const missingUserDelete = await auth.deleteAuthentication({
      email: "nonexistent@example.com",
    });
    assertEquals(
      "error" in missingUserDelete,
      true,
      "Deletion should fail for non-existent email",
    );
    if ("error" in missingUserDelete) {
      assertEquals(missingUserDelete.error, "User not found");
    }

    const stillCanLogin = await auth.login({
      email: emailB,
      password: passwordB,
    });
    assertEquals(
      "error" in stillCanLogin,
      false,
      "Existing users should remain after unrelated delete failure",
    );
  } finally {
    await client.close();
  }
});
