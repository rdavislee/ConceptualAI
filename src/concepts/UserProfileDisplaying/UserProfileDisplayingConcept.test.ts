import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import UserProfileDisplayingConcept from "./UserProfileDisplayingConcept.ts";

const userA = "user:Alice" as ID;
const userB = "user:Bob" as ID;

Deno.test("Principle: A user sets profile fields; others read them for display; edits update fields without affecting other concerns", async () => {
  const [db, client] = await testDb();
  const profileConcept = new UserProfileDisplayingConcept(db);

  try {
    console.log("Testing principle: User sets profile fields, others read them, edits update independently");

    // 1. User A sets their profile fields
    console.log("Step 1: User A sets all profile fields");
    const setProfileResult = await profileConcept.setProfile({
      user: userA,
      username: "alice_smith",
      displayName: "Alice Smith",
      avatarUrl: "https://example.com/avatar.jpg",
      bio: "Software engineer and cat lover",
    });
    assertEquals(
      "error" in setProfileResult,
      false,
      "Setting profile should succeed",
    );
    assertEquals("ok" in setProfileResult, true);

    // 2. Others (User B) can read the profile for display
    console.log("Step 2: User B reads User A's profile");
    const profile = await profileConcept._profileOf({ user: userA });
    assertEquals(profile.length, 1, "Query should return one profile");
    assertEquals(
      profile[0].username,
      "alice_smith",
      "Username should be set correctly",
    );
    assertEquals(
      profile[0].displayName,
      "Alice Smith",
      "Display name should be set correctly",
    );
    assertEquals(
      profile[0].avatarUrl,
      "https://example.com/avatar.jpg",
      "Avatar URL should be set correctly",
    );
    assertEquals(
      profile[0].bio,
      "Software engineer and cat lover",
      "Bio should be set correctly",
    );

    // 3. Edits update fields without affecting other concerns
    console.log("Step 3: User A updates only the display name");
    const updateNameResult = await profileConcept.setProfile({
      user: userA,
      displayName: "Alice J. Smith",
    });
    assertEquals(
      "error" in updateNameResult,
      false,
      "Updating display name should succeed",
    );

    // Verify that only displayName changed, other fields remain unchanged
    const updatedProfile = await profileConcept._profileOf({ user: userA });
    assertEquals(
      updatedProfile[0].username,
      "alice_smith",
      "Username should remain unchanged",
    );
    assertEquals(
      updatedProfile[0].displayName,
      "Alice J. Smith",
      "Display name should be updated",
    );
    assertEquals(
      updatedProfile[0].avatarUrl,
      "https://example.com/avatar.jpg",
      "Avatar URL should remain unchanged",
    );
    assertEquals(
      updatedProfile[0].bio,
      "Software engineer and cat lover",
      "Bio should remain unchanged",
    );

    console.log("✓ Principle test passed: Fields can be set independently and read by others");
  } finally {
    await client.close();
  }
});

Deno.test("Action: setProfile requires user exists and effects set only provided fields", async () => {
  const [db, client] = await testDb();
  const profileConcept = new UserProfileDisplayingConcept(db);

  try {
    console.log("Testing setProfile action");

    // Test requires: user must be provided
    console.log("Testing requires: user ID is required");
    const missingUserResult = await profileConcept.setProfile({
      user: "" as ID,
      displayName: "Test Name",
    });
    assertEquals(
      "error" in missingUserResult,
      true,
      "Should fail when user ID is empty",
    );

    // Test effects: setting all fields
    console.log("Testing effects: all fields can be set");
    const result = await profileConcept.setProfile({
      user: userA,
      username: "testuser",
      displayName: "Test Display Name",
      avatarUrl: "https://example.com/avatar.jpg",
      bio: "Test bio",
    });
    assertEquals(
      "error" in result,
      false,
      "Setting profile with valid user should succeed",
    );
    assertEquals("ok" in result, true);

    // Verify the effect using the query
    let profile = await profileConcept._profileOf({ user: userA });
    assertEquals(
      profile[0].username,
      "testuser",
      "Username should be set to the provided value",
    );
    assertEquals(
      profile[0].displayName,
      "Test Display Name",
      "Display name should be set to the provided value",
    );
    assertEquals(
      profile[0].avatarUrl,
      "https://example.com/avatar.jpg",
      "Avatar URL should be set to the provided value",
    );
    assertEquals(
      profile[0].bio,
      "Test bio",
      "Bio should be set to the provided value",
    );

    // Test that updating only one field works (others remain unchanged)
    console.log("Testing update: only displayName can be changed");
    await profileConcept.setProfile({
      user: userA,
      displayName: "Updated Name",
    });
    profile = await profileConcept._profileOf({ user: userA });
    assertEquals(
      profile[0].username,
      "testuser",
      "Username should remain unchanged",
    );
    assertEquals(
      profile[0].displayName,
      "Updated Name",
      "Display name should be updated",
    );
    assertEquals(
      profile[0].avatarUrl,
      "https://example.com/avatar.jpg",
      "Avatar URL should remain unchanged",
    );
    assertEquals(
      profile[0].bio,
      "Test bio",
      "Bio should remain unchanged",
    );

    // Test updating only username
    console.log("Testing update: only username can be changed");
    await profileConcept.setProfile({
      user: userA,
      username: "newusername",
    });
    profile = await profileConcept._profileOf({ user: userA });
    assertEquals(
      profile[0].username,
      "newusername",
      "Username should be updated",
    );
    assertEquals(
      profile[0].displayName,
      "Updated Name",
      "Display name should remain unchanged",
    );
    assertEquals(
      profile[0].avatarUrl,
      "https://example.com/avatar.jpg",
      "Avatar URL should remain unchanged",
    );
    assertEquals(
      profile[0].bio,
      "Test bio",
      "Bio should remain unchanged",
    );

    // Test updating only avatarUrl
    console.log("Testing update: only avatarUrl can be changed");
    await profileConcept.setProfile({
      user: userA,
      avatarUrl: "https://example.com/new-avatar.png",
    });
    profile = await profileConcept._profileOf({ user: userA });
    assertEquals(
      profile[0].username,
      "newusername",
      "Username should remain unchanged",
    );
    assertEquals(
      profile[0].displayName,
      "Updated Name",
      "Display name should remain unchanged",
    );
    assertEquals(
      profile[0].avatarUrl,
      "https://example.com/new-avatar.png",
      "Avatar URL should be updated",
    );
    assertEquals(
      profile[0].bio,
      "Test bio",
      "Bio should remain unchanged",
    );

    // Test updating only bio
    console.log("Testing update: only bio can be changed");
    await profileConcept.setProfile({
      user: userA,
      bio: "Updated bio text",
    });
    profile = await profileConcept._profileOf({ user: userA });
    assertEquals(
      profile[0].username,
      "newusername",
      "Username should remain unchanged",
    );
    assertEquals(
      profile[0].displayName,
      "Updated Name",
      "Display name should remain unchanged",
    );
    assertEquals(
      profile[0].avatarUrl,
      "https://example.com/new-avatar.png",
      "Avatar URL should remain unchanged",
    );
    assertEquals(
      profile[0].bio,
      "Updated bio text",
      "Bio should be updated",
    );

    console.log("✓ setProfile action test passed");
  } finally {
    await client.close();
  }
});

Deno.test("Query: _profileOf returns profile information or empty strings if profile doesn't exist", async () => {
  const [db, client] = await testDb();
  const profileConcept = new UserProfileDisplayingConcept(db);

  try {
    console.log("Testing _profileOf query");

    // Test query for non-existent profile returns empty strings
    console.log("Testing: non-existent profile returns empty strings");
    const emptyProfile = await profileConcept._profileOf({ user: userB });
    assertEquals(emptyProfile.length, 1, "Query should return one result");
    assertEquals(
      emptyProfile[0].username,
      "",
      "Username should be empty string for non-existent profile",
    );
    assertEquals(
      emptyProfile[0].displayName,
      "",
      "Display name should be empty string for non-existent profile",
    );
    assertEquals(
      emptyProfile[0].avatarUrl,
      "",
      "Avatar URL should be empty string for non-existent profile",
    );
    assertEquals(
      emptyProfile[0].bio,
      "",
      "Bio should be empty string for non-existent profile",
    );

    // Set some profile fields
    await profileConcept.setProfile({
      user: userB,
      username: "bob_johnson",
      displayName: "Bob Johnson",
      avatarUrl: "https://example.com/bob.jpg",
      bio: "Bob's bio",
    });

    // Test query returns correct values
    console.log("Testing: existing profile returns correct values");
    const profile = await profileConcept._profileOf({ user: userB });
    assertEquals(profile.length, 1, "Query should return one result");
    assertEquals(
      profile[0].username,
      "bob_johnson",
      "Username should match",
    );
    assertEquals(
      profile[0].displayName,
      "Bob Johnson",
      "Display name should match",
    );
    assertEquals(
      profile[0].avatarUrl,
      "https://example.com/bob.jpg",
      "Avatar URL should match",
    );
    assertEquals(profile[0].bio, "Bob's bio", "Bio should match");

    // Test partial profile (only some fields set)
    // Use a fresh user to test that only provided fields are set
    console.log("Testing: partial profile returns correct values");
    const userC = "user:Charlie" as ID;
    await profileConcept.setProfile({
      user: userC,
      username: "charlie",
      displayName: "Bob",
      // avatarUrl and bio are omitted - they remain unset
    });
    const partialProfile = await profileConcept._profileOf({ user: userC });
    assertEquals(
      partialProfile[0].username,
      "charlie",
      "Set username should return value",
    );
    assertEquals(
      partialProfile[0].displayName,
      "Bob",
      "Set field should return value",
    );
    assertEquals(
      partialProfile[0].avatarUrl,
      "",
      "Unset field should return empty string",
    );
    assertEquals(
      partialProfile[0].bio,
      "",
      "Unset field should return empty string",
    );

    console.log("✓ _profileOf query test passed");
  } finally {
    await client.close();
  }
});

Deno.test("Independent field updates: editing one field does not affect others", async () => {
  const [db, client] = await testDb();
  const profileConcept = new UserProfileDisplayingConcept(db);

  try {
    console.log("Testing that field updates are independent");

    // Set all fields initially
    await profileConcept.setProfile({
      user: userA,
      username: "initial_user",
      displayName: "Initial Name",
      avatarUrl: "https://example.com/initial.jpg",
      bio: "Initial bio",
    });

    // Update only username
    console.log("Updating only username");
    await profileConcept.setProfile({
      user: userA,
      username: "updated_user",
    });
    let profile = await profileConcept._profileOf({ user: userA });
    assertEquals(profile[0].username, "updated_user");
    assertEquals(profile[0].displayName, "Initial Name");
    assertEquals(profile[0].avatarUrl, "https://example.com/initial.jpg");
    assertEquals(profile[0].bio, "Initial bio");

    // Update only displayName
    console.log("Updating only displayName");
    await profileConcept.setProfile({
      user: userA,
      displayName: "Updated Name",
    });
    profile = await profileConcept._profileOf({ user: userA });
    assertEquals(profile[0].username, "updated_user");
    assertEquals(profile[0].displayName, "Updated Name");
    assertEquals(profile[0].avatarUrl, "https://example.com/initial.jpg");
    assertEquals(profile[0].bio, "Initial bio");

    // Update only avatarUrl
    console.log("Updating only avatarUrl");
    await profileConcept.setProfile({
      user: userA,
      avatarUrl: "https://example.com/new.jpg",
    });
    profile = await profileConcept._profileOf({ user: userA });
    assertEquals(profile[0].username, "updated_user");
    assertEquals(profile[0].displayName, "Updated Name");
    assertEquals(profile[0].avatarUrl, "https://example.com/new.jpg");
    assertEquals(profile[0].bio, "Initial bio");

    // Update only bio
    console.log("Updating only bio");
    await profileConcept.setProfile({
      user: userA,
      bio: "Updated bio",
    });
    profile = await profileConcept._profileOf({ user: userA });
    assertEquals(profile[0].username, "updated_user");
    assertEquals(profile[0].displayName, "Updated Name");
    assertEquals(profile[0].avatarUrl, "https://example.com/new.jpg");
    assertEquals(profile[0].bio, "Updated bio");

    console.log("✓ Independent field updates test passed");
  } finally {
    await client.close();
  }
});

