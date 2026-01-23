import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import StoryingConcept, { Author } from "./StoryingConcept.ts";

const authorA = "user:Alice" as Author;
const authorB = "user:Bob" as Author;

Deno.test("Principle: Story lifecycle - creation, active check, expiration, and cleanup", async () => {
  const [db, client] = await testDb();
  const storying = new StoryingConcept(db);
  try {
    // 1. Create a short-lived story (0.5 seconds)
    const createRes = await storying.createStory({
      author: authorA,
      content: { text: "My ephemeral thought" },
      durationSeconds: 0.5,
      type: "text",
    });
    
    assertEquals("story" in createRes, true, "Story creation should succeed");
    const storyId = (createRes as { story: string }).story;

    // 2. Verify it is currently active
    const activeRes = await storying._activeStories({});
    const activeStories = activeRes[0].stories;
    assertEquals(activeStories.some(s => s._id === storyId), true, "Story should be active immediately");

    // 3. Wait for expiration (600ms)
    await new Promise((resolve) => setTimeout(resolve, 600));

    // 4. Verify it is no longer considered active (dynamic query check)
    const activeResLater = await storying._activeStories({});
    const activeStoriesLater = activeResLater[0].stories;
    assertEquals(activeStoriesLater.some(s => s._id === storyId), false, "Story should not be active after expiration");

    // 5. Verify it still exists in the database (before cleanup) via author query
    const authorStories = await storying._getStoriesByAuthor({ author: authorA });
    assertEquals(authorStories[0].stories.some(s => s._id === storyId), true, "Story should still exist before cleanup");

    // 6. Run cleanup
    const cleanupRes = await storying.checkExpirations({});
    assertEquals("count" in cleanupRes, true);
    assertEquals((cleanupRes as { count: number }).count >= 1, true, "Should have deleted at least one story");

    // 7. Verify physical deletion
    const finalStories = await storying._getStoriesByAuthor({ author: authorA });
    assertEquals(finalStories[0].stories.some(s => s._id === storyId), false, "Story should be deleted after cleanup");

  } finally {
    await client.close();
  }
});

Deno.test("Action: createStory - Validation", async () => {
  const [db, client] = await testDb();
  const storying = new StoryingConcept(db);
  try {
    // Empty content
    const res1 = await storying.createStory({
      author: authorA,
      content: {},
      durationSeconds: 10
    });
    assertEquals("error" in res1, true, "Should fail with empty content");

    // Invalid duration (0)
    const res2 = await storying.createStory({
      author: authorA,
      content: { img: "..." },
      durationSeconds: 0
    });
    assertEquals("error" in res2, true, "Should fail with 0 duration");

    // Invalid duration (negative)
    const res3 = await storying.createStory({
      author: authorA,
      content: { img: "..." },
      durationSeconds: -5
    });
    assertEquals("error" in res3, true, "Should fail with negative duration");

  } finally {
    await client.close();
  }
});

Deno.test("Action: deleteStory - Authorization and Existence", async () => {
  const [db, client] = await testDb();
  const storying = new StoryingConcept(db);
  try {
    const createRes = await storying.createStory({
      author: authorA,
      content: { text: "Delete me" },
      durationSeconds: 60
    });
    const storyId = (createRes as { story: string }).story;

    // Wrong author
    const res1 = await storying.deleteStory({ story: storyId as ID, author: authorB });
    assertEquals("error" in res1, true, "Should fail if wrong author tries to delete");

    // Correct author
    const res2 = await storying.deleteStory({ story: storyId as ID, author: authorA });
    assertEquals("ok" in res2, true, "Should succeed with correct author");

    // Already deleted / Non-existent
    const res3 = await storying.deleteStory({ story: storyId as ID, author: authorA });
    assertEquals("error" in res3, true, "Should fail if story does not exist");

  } finally {
    await client.close();
  }
});

Deno.test("Action: checkExpirations - Mixed Expirations", async () => {
  const [db, client] = await testDb();
  const storying = new StoryingConcept(db);
  try {
    // Story A: Expires quickly (0.2s)
    const resA = await storying.createStory({
      author: authorA,
      content: { id: "A" },
      durationSeconds: 0.2
    });
    const idA = (resA as { story: string }).story;

    // Story B: Expires later (2s)
    const resB = await storying.createStory({
      author: authorA,
      content: { id: "B" },
      durationSeconds: 2
    });
    const idB = (resB as { story: string }).story;

    // Wait 0.5s (A expired, B active)
    await new Promise(r => setTimeout(r, 500));

    // Run cleanup
    const cleanup = await storying.checkExpirations({});
    assertEquals((cleanup as { count: number }).count, 1, "Should delete exactly 1 story");

    // Verify A is gone, B remains
    const storiesRes = await storying._getStoriesByAuthor({ author: authorA });
    const stories = storiesRes[0].stories;
    
    const hasA = stories.some(s => s._id === idA);
    const hasB = stories.some(s => s._id === idB);

    assertEquals(hasA, false, "Story A should be deleted");
    assertEquals(hasB, true, "Story B should remain");

  } finally {
    await client.close();
  }
});

Deno.test("Queries: _getStoriesByAuthor and _activeStories", async () => {
  const [db, client] = await testDb();
  const storying = new StoryingConcept(db);
  try {
    // Setup:
    // Alice: 1 active story
    // Bob: 1 active story
    await storying.createStory({ author: authorA, content: { c: 1 }, durationSeconds: 10 });
    await storying.createStory({ author: authorB, content: { c: 2 }, durationSeconds: 10 });

    // _getStoriesByAuthor
    const aliceRes = await storying._getStoriesByAuthor({ author: authorA });
    assertEquals(aliceRes[0].stories.length, 1);
    assertEquals(aliceRes[0].stories[0].author, authorA);

    // _activeStories
    const activeRes = await storying._activeStories({});
    // Should see both
    assertEquals(activeRes[0].stories.length >= 2, true);

    // Ensure sorting (latest first)
    // Add another for Alice
    await new Promise(r => setTimeout(r, 10)); // Ensure time difference
    await storying.createStory({ author: authorA, content: { c: 3 }, durationSeconds: 10 });

    const aliceRes2 = await storying._getStoriesByAuthor({ author: authorA });
    assertEquals(aliceRes2[0].stories.length, 2);
    // Check sort order: latest created should be first
    const t1 = new Date(aliceRes2[0].stories[0].createdAt).getTime();
    const t2 = new Date(aliceRes2[0].stories[1].createdAt).getTime();
    assertEquals(t1 > t2, true, "Stories should be sorted by createdAt descending");

  } finally {
    await client.close();
  }
});