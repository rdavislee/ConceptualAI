import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import StoryingConcept, { Author, Story } from "./StoryingConcept.ts";

const author1 = "user:1" as Author;
const author2 = "user:2" as Author;
const viewer1 = "user:3" as Author;
const viewer2 = "user:4" as Author;

Deno.test({
  name: "Storying: Basic lifecycle with views",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const storying = new StoryingConcept(db);
    try {
      // 1. Post a story (100 seconds)
      const postRes = await storying.post({
        author: author1,
        content: { url: "img.png" },
        durationSeconds: 100,
      });
      if ("error" in postRes) throw new Error(postRes.error);
      const storyId = postRes.story;

      // 2. Verify active
      const activeStories = await storying._getActiveStories({ authors: [author1] });
      assertEquals(activeStories[0].stories.length, 1);
      assertEquals(activeStories[0].stories[0].content.url, "img.png");

      // 3. Record views
      await storying.recordView({ story: storyId, viewer: viewer1 });
      await storying.recordView({ story: storyId, viewer: viewer2 });

      // 4. Verify view count
      const views = await storying._getViews({ story: storyId });
      assertEquals(views[0].views.length, 2);

      // 5. Expire (delete)
      await storying.expire({ story: storyId });

      // 6. Verify gone
      const activeAfter = await storying._getActiveStories({ authors: [author1] });
      assertEquals(activeAfter[0].stories.length, 0);

      const viewsAfter = await storying._getViews({ story: storyId });
      assertEquals(viewsAfter[0].views.length, 0);

    } finally {
      await client.close();
    }
  }
});

Deno.test({
  name: "Storying: Temporal Expiration",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const storying = new StoryingConcept(db);
    try {
      // Post one short-lived story
      await storying.post({
        author: author1,
        content: { text: "fast" },
        durationSeconds: 1,
      });

      // Wait 2 seconds
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Should no longer be active
      const active = await storying._getActiveStories({ authors: [author1] });
      assertEquals(active[0].stories.length, 0);

    } finally {
      await client.close();
    }
  }
});

Deno.test({
  name: "Storying: Multi-author queries",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const storying = new StoryingConcept(db);
    try {
      await storying.post({ author: author1, content: { id: 1 }, durationSeconds: 100 });
      await storying.post({ author: author2, content: { id: 2 }, durationSeconds: 100 });

      const feed = await storying._getActiveStories({ authors: [author1, author2] });
      assertEquals(feed[0].stories.length, 2);

      const justAuthor1 = await storying._getActiveStories({ authors: [author1] });
      assertEquals(justAuthor1[0].stories.length, 1);

    } finally {
      await client.close();
    }
  }
});

Deno.test({
  name: "Storying: Edge Cases & Validation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const storying = new StoryingConcept(db);
    try {
      // 1. Empty content should fail
      const emptyContent = await storying.post({ author: author1, content: {}, durationSeconds: 100 });
      assertEquals("error" in emptyContent, true, "Empty content should fail");

      // 2. Invalid duration should fail
      const badDuration = await storying.post({ author: author1, content: { text: "hi" }, durationSeconds: 0 });
      assertEquals("error" in badDuration, true, "Zero duration should fail");

      // 3. Valid post for remaining tests
      const postRes = await storying.post({ author: author1, content: { text: "test" }, durationSeconds: 100 });
      if ("error" in postRes) throw new Error(postRes.error);
      const storyId = postRes.story;

      // 4. Self-view should fail
      const err1 = await storying.recordView({ story: storyId, viewer: author1 });
      assertEquals("error" in err1, true, "Self-view should fail");

      // 5. Duplicate view should fail
      await storying.recordView({ story: storyId, viewer: viewer1 });
      const err2 = await storying.recordView({ story: storyId, viewer: viewer1 });
      assertEquals("error" in err2, true, "Duplicate view should fail");

      // 6. View non-existent story should fail
      const err3 = await storying.recordView({ story: "nonexistent-story-id" as Story, viewer: viewer1 });
      assertEquals("error" in err3, true, "View non-existent should fail");

      // 7. Expire non-existent story should fail
      const err4 = await storying.expire({ story: "nonexistent-story-id" as Story });
      assertEquals("error" in err4, true, "Expire non-existent should fail");

    } finally {
      await client.close();
    }
  }
});
