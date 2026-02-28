import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ProfilingConcept, { User } from "./ProfilingConcept.ts";

const authorA = "user:Alice" as User;
const authorB = "user:Bob" as User;

Deno.test({
  name: "Principle: user creates then updates their profile",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const profiling = new ProfilingConcept(db);
    try {
      // 1. Create Profile
      const createRes = await profiling.createProfile({
        user: authorA,
        username: "alice",
        name: "Alice",
        bio: "Software Engineer",
        bioImageUrl: "https://example.com/alice.jpg",
      });
      assertEquals("ok" in createRes, true, "Profile creation should succeed");

      // 2. Verify creation
      let getRes = await profiling._getProfile({ user: authorA });
      let profile = getRes[0].profile;
      assertNotEquals(profile, null);
      assertEquals(profile?.username, "alice");
      assertEquals(profile?.name, "Alice");
      assertEquals(profile?.bio, "Software Engineer");
      assertNotEquals(profile?.createdAt, undefined);
      assertEquals(profile?.createdAt, profile?.updatedAt);

      // 3. Update Profile
      await new Promise((r) => setTimeout(r, 10)); // Ensure updatedAt changes
      const updateRes = await profiling.updateProfile({
        user: authorA,
        bio: "Lead Developer",
      });
      assertEquals("ok" in updateRes, true, "Profile update should succeed");

      // 4. Verify update
      getRes = await profiling._getProfile({ user: authorA });
      profile = getRes[0].profile;
      assertEquals(profile?.bio, "Lead Developer");
      assertEquals(profile?.name, "Alice", "Name should remain unchanged");
      assertNotEquals(profile?.updatedAt, profile?.createdAt);

      // 4.5. Verify _getProfileByUsername
      const getByUsernameRes = await profiling._getProfileByUsername({
        username: "alice",
      });
      assertEquals(getByUsernameRes[0].profile?._id, authorA);

      // 4.6. Change Username
      const changeRes = await profiling.changeUsername({
        user: authorA,
        newUsername: "alice_new",
      });
      assertEquals("ok" in changeRes, true, "Username change should succeed");
      const getByNewUsernameRes = await profiling._getProfileByUsername({
        username: "alice_new",
      });
      assertEquals(getByNewUsernameRes[0].profile?._id, authorA);

      // 5. Delete Profile
      const delRes = await profiling.deleteProfile({ user: authorA });
      assertEquals("ok" in delRes, true);
      getRes = await profiling._getProfile({ user: authorA });
      assertEquals(getRes[0].profile, null);
    } finally {
      await client.close();
    }
  },
});

Deno.test("Action: createProfile - Edge Cases", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    await profiling.createProfile({ user: authorA, username: "alice", name: "A", bio: "B", bioImageUrl: "I" });

    // Duplicate creation (same user)
    const err = await profiling.createProfile({ user: authorA, username: "alice2", name: "A2", bio: "B2", bioImageUrl: "I2" });
    assertEquals("error" in err, true, "Should fail if profile already exists");

    // Duplicate creation (same username)
    const err2 = await profiling.createProfile({ user: authorB, username: "alice", name: "B", bio: "B", bioImageUrl: "I" });
    assertEquals("error" in err2, true, "Should fail if username is taken");
  } finally {
    await client.close();
  }
});

Deno.test("Action: updateProfile - Requirements", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    // Update non-existent
    const err1 = await profiling.updateProfile({ user: authorA, bio: "X" });
    assertEquals("error" in err1, true, "Should fail for non-existent profile");

    // Empty update
    await profiling.createProfile({ user: authorB, username: "bob", name: "B", bio: "B", bioImageUrl: "I" });
    const err2 = await profiling.updateProfile({ user: authorB });
    assertEquals("error" in err2, true, "Should fail if no fields provided");

    // Taken username update
    await profiling.createProfile({ user: authorA, username: "alice", name: "A", bio: "A", bioImageUrl: "I" });
    const err3 = await profiling.updateProfile({ user: authorB, username: "alice" });
    assertEquals("error" in err3, true, "Should fail if username taken by another");

    // Own username update (no change)
    const res = await profiling.updateProfile({ user: authorB, username: "bob" });
    assertEquals("ok" in res, true, "Should succeed if same username");
  } finally {
    await client.close();
  }
});

Deno.test("Action: deleteProfile - Edge Cases", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    const err = await profiling.deleteProfile({ user: authorA });
    assertEquals("error" in err, true, "Should fail to delete non-existent profile");
  } finally {
    await client.close();
  }
});

Deno.test("Query: _searchProfiles", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    // Setup data
    await profiling.createProfile({
      user: "user:1" as User,
      username: "alice_wonder",
      name: "Alice Wonderland",
      bio: "A",
      bioImageUrl: "I",
    });
    await profiling.createProfile({
      user: "user:2" as User,
      username: "bob_builder",
      name: "Bob The Builder",
      bio: "B",
      bioImageUrl: "I",
    });
    await profiling.createProfile({
      user: "user:3" as User,
      username: "charlie_chaplin",
      name: "Charlie Chaplin",
      bio: "C",
      bioImageUrl: "I",
    });

    // 1. Search by username prefix
    const res1 = await profiling._searchProfiles({ query: "alice" });
    assertEquals(res1[0].profiles.length, 1);
    assertEquals(res1[0].profiles[0].username, "alice_wonder");

    // 2. Search by name match
    const res2 = await profiling._searchProfiles({ query: "Builder" });
    assertEquals(res2[0].profiles.length, 1);
    assertEquals(res2[0].profiles[0].name, "Bob The Builder");

    // 3. Case-insensitive
    const res3 = await profiling._searchProfiles({ query: "ALICE" });
    assertEquals(res3[0].profiles.length, 1);
    assertEquals(res3[0].profiles[0].username, "alice_wonder");

    // 4. Multiple matches
    // Both Alice and Bob have "b" in their name/username... wait,
    // Alice Wonderland -> no "b"
    // Bob The Builder -> has "b"
    // Charlie Chaplin -> no "b"
    // Let's search for "user" -> none
    // Let's search for "a" -> Alice, Charlie (Chaplin) -- Bob has no 'a'
    const res4 = await profiling._searchProfiles({ query: "a" });
    assertEquals(res4[0].profiles.length, 2);

    // 5. Empty query
    const res5 = await profiling._searchProfiles({ query: "   " });
    assertEquals(res5[0].profiles.length, 0);

  } finally {
    await client.close();
  }
});

Deno.test("Query: _getProfilesByIds preserves input order and omits missing", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    await profiling.createProfile({
      user: "user:1" as User,
      username: "u1",
      name: "User One",
      bio: "A",
      bioImageUrl: "I",
    });
    await profiling.createProfile({
      user: "user:2" as User,
      username: "u2",
      name: "User Two",
      bio: "B",
      bioImageUrl: "I",
    });

    const res = await profiling._getProfilesByIds({
      users: ["user:2" as User, "user:missing" as User, "user:1" as User],
    });

    assertEquals(res[0].profiles.length, 2);
    assertEquals(res[0].profiles[0]._id, "user:2" as User);
    assertEquals(res[0].profiles[1]._id, "user:1" as User);
  } finally {
    await client.close();
  }
});
