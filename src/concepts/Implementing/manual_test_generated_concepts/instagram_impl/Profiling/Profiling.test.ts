import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ProfilingConcept, { User } from "./ProfilingConcept.ts";

const userA = "user:Alice" as User;

Deno.test("Principle: user creates then updates their profile", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    // Initially null
    const initial = await profiling._getProfile({ user: userA });
    assertEquals(initial[0].profile, null);

    // Create profile
    const createRes = await profiling.updateProfile({ user: userA, name: "Alice", bio: "Tech enthusiast" });
    assertEquals("ok" in createRes, true, "Creation should succeed");

    // Verify creation
    const createdArr = await profiling._getProfile({ user: userA });
    assertEquals(createdArr[0].profile?.name, "Alice");
    assertEquals(createdArr[0].profile?.bio, "Tech enthusiast");

    // Update profile
    const updateRes = await profiling.updateProfile({ user: userA, bio: "Tech enthusiast & runner" });
    assertEquals("ok" in updateRes, true, "Update should succeed");

    // Verify update
    const updatedArr = await profiling._getProfile({ user: userA });
    assertEquals(updatedArr[0].profile?.name, "Alice"); // Unchanged
    assertEquals(updatedArr[0].profile?.bio, "Tech enthusiast & runner");
  } finally {
    await client.close();
  }
});

Deno.test("Action: updateProfile requires at least one field", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    const res = await profiling.updateProfile({ user: userA });
    assertEquals("error" in res, true, "Updating with no fields should fail");
  } finally {
    await client.close();
  }
});

Deno.test("Action: updateProfile updates bioImageUrl", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    await profiling.updateProfile({ user: userA, bioImageUrl: "https://example.com/pic.jpg" });
    const profile = await profiling._getProfile({ user: userA });
    assertEquals(profile[0].profile?.bioImageUrl, "https://example.com/pic.jpg");
  } finally {
    await client.close();
  }
});

Deno.test("Action: deleteProfile deletes the profile", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    // Setup
    await profiling.updateProfile({ user: userA, name: "To Delete" });

    // Check exists
    const before = await profiling._getProfile({ user: userA });
    assertEquals(before[0].profile !== null, true);

    // Delete
    const res = await profiling.deleteProfile({ user: userA });
    assertEquals("ok" in res, true, "Delete should succeed");

    // Check gone
    const after = await profiling._getProfile({ user: userA });
    assertEquals(after[0].profile, null);
  } finally {
    await client.close();
  }
});

Deno.test("Action: deleteProfile fails if profile does not exist", async () => {
  const [db, client] = await testDb();
  const profiling = new ProfilingConcept(db);
  try {
    const res = await profiling.deleteProfile({ user: "user:NonExistent" as User });
    assertEquals("error" in res, true, "Delete non-existent should fail");
  } finally {
    await client.close();
  }
});
