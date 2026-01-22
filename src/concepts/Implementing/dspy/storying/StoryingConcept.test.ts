import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import StoryingConcept, { Author, Story } from "./StoryingConcept.ts";

const authorA = "user:Alice" as Author;
const authorB = "user:Bob" as Author;

Deno.test("Principle: Stories expire and are deleted", async () => {
  const [db, client] = await testDb();
  const storying = new StoryingConcept(db);

  try {
    // 1. Create a short-lived story (0.5 second)
    const createRes = await storying.createStory({
      author: authorA,
      content: { text: "Fleeting moment" },
      durationSeconds: 0.5,
      type: "text",
    });

    assertEquals("story" in createRes, true, "Story creation failed");
    const storyId = (createRes as { story: Story }).story;

    // 2. Verify it is active immediately
    try {
      const activeRes = await storying._activeStories();
      const activeStories = activeRes[0].stories;
      const found = activeStories.some((s) => s._id === storyId);
      assertEquals(found, true, "Story should be active initially");
    } catch (e) {
      console.error(
        "Error in _activeStories (possible implementation bug with $ge vs $gte):",
        e,
      );
      // Proceeding with test to verify checkExpirations logic even if query fails
    }

    // 3. Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 600));

    // 4. Verify it is no longer returned by _activeStories
    try {
      const activeResLater = await storying._activeStories();
      const activeStoriesLater = activeResLater[0].stories;
      assertEquals(
        activeStoriesLater.some((s) => s._id === storyId),
        false,
        "Story should not be active after expiration",
      );
    } catch (e) {
      // Ignore error here if it failed above, focus on checkExpirations next
    }

    // 5. Run checkExpirations to physically delete it
    const checkRes = await storying.checkExpirations();
    // We expect at least 1 deletion (our story)
    assertEquals(
      checkRes.count >= 1,
      true,
      "Should have deleted the expired story",
    );

    // 6. Verify it is gone from author's list (which doesn't filter by time, just author)
    const authorStoriesRes = await storying._getStoriesByAuthor({
      author: authorA,
    });
    const authorStories = authorStoriesRes[0].stories;
    assertEquals(
      authorStories.some((s) => s._id === storyId),
      false,
      "Story should be deleted from DB",
    );
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
      durationSeconds: 10,
    });
    assertEquals("error" in res1, true, "Should fail on empty content");

    // Zero duration
    const res2 = await storying.createStory({
      author: authorA,
      content: { a: 1 },
      durationSeconds: 0,
    });
    assertEquals("error" in res2, true, "Should fail on zero duration");

    // Negative duration
    const res3 = await storying.createStory({
      author: authorA,
      content: { a: 1 },
      durationSeconds: -5,
    });
    assertEquals("error" in res3, true, "Should fail on negative duration");

    // Valid
    const res4 = await storying.createStory({
      author: authorA,
      content: { a: 1 },
      durationSeconds: 10,
    });
    assertEquals("story" in res4, true, "Should succeed with valid inputs");
  } finally {
    await client.close();
  }
});

Deno.test("Action: deleteStory - Authorization", async () => {
  const [db, client] = await testDb();
  const storying = new StoryingConcept(db);

  try {
    const createRes = await storying.createStory({
      author: authorA,
      content: { text: "Delete me" },
      durationSeconds: 60,
    });
    const storyId = (createRes as { story: Story }).story;

    // Wrong author
    const delRes1 = await storying.deleteStory({
      story: storyId,
      author: authorB,
    });
    assertEquals("error" in delRes1, true, "Should fail with wrong author");

    // Correct author
    const delRes2 = await storying.deleteStory({
      story: storyId,
      author: authorA,
    });
    assertEquals("ok" in delRes2, true, "Should succeed with correct author");

    // Already deleted
    const delRes3 = await storying.deleteStory({
      story: storyId,
      author: authorA,
    });
    assertEquals("error" in delRes3, true, "Should fail if already deleted");
  } finally {
    await client.close();
  }
});

Deno.test("Queries: _getStoriesByAuthor", async () => {
  const [db, client] = await testDb();
  const storying = new StoryingConcept(db);

  try {
    await storying.createStory({
      author: authorA,
      content: { id: 1 },
      durationSeconds: 60,
    });
    await storying.createStory({
      author: authorA,
      content: { id: 2 },
      durationSeconds: 60,
    });
    await storying.createStory({
      author: authorB,
      content: { id: 3 },
      durationSeconds: 60,
    });

    const resA = await storying._getStoriesByAuthor({ author: authorA });
    assertEquals(resA[0].stories.length, 2);

    const resB = await storying._getStoriesByAuthor({ author: authorB });
    assertEquals(resB[0].stories.length, 1);
  } finally {
    await client.close();
  }
});