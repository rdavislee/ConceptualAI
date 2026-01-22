import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import PostingConcept, { Author } from "./PostingConcept.ts";

const authorA = "user:Alice" as Author;
const authorB = "user:Bob" as Author;

Deno.test("Principle: user creates, edits, and deletes a post with optional fields", async () => {
  const [db, client] = await testDb();
  const posting = new PostingConcept(db);
  try {
    // 1. Create post with type and metadata
    const createRes = await posting.createPost({
      author: authorA,
      content: { body: "Hello world" },
      type: "story",
      metadata: { location: "Boston" }
    });
    assertEquals("postId" in createRes, true, "Creation should succeed");
    const postId = (createRes as { postId: string }).postId;

    // 2. Verify retrieval
    const postArr = await posting._getPost({ postId });
    const post = postArr[0].post;
    assertNotEquals(post, null);
    assertEquals(post?.content.body, "Hello world");
    assertEquals(post?.type, "story");
    assertEquals(post?.metadata?.location, "Boston");
    assertNotEquals(post?.createdAt, undefined);
    assertEquals(post?.createdAt, post?.updatedAt);

    // 3. Edit post (changing type and metadata)
    // Wait a moment to ensure updatedAt changes
    await new Promise(r => setTimeout(r, 10));
    const editRes = await posting.editPost({
      postId,
      author: authorA,
      content: { body: "Updated body" },
      type: "post",
      metadata: { location: "New York" }
    });
    assertEquals("ok" in editRes, true, "Edit should succeed");

    // 4. Verify update
    const updatedPostArr = await posting._getPost({ postId });
    const updatedPost = updatedPostArr[0].post;
    assertEquals(updatedPost?.content.body, "Updated body");
    assertEquals(updatedPost?.type, "post");
    assertEquals(updatedPost?.metadata?.location, "New York");
    assertNotEquals(updatedPost?.updatedAt, post?.updatedAt);

    // 5. Delete post
    const deleteRes = await posting.deletePost({ postId, author: authorA });
    assertEquals("ok" in deleteRes, true, "Delete should succeed");

    // 6. Verify deletion
    const finalPostArr = await posting._getPost({ postId });
    assertEquals(finalPostArr[0].post, null);
  } finally {
    await client.close();
  }
});

Deno.test("Action: createPost - Edge Cases", async () => {
  const [db, client] = await testDb();
  const posting = new PostingConcept(db);
  try {
    // Empty object
    const res1 = await posting.createPost({ author: authorA, content: {} });
    assertEquals("error" in res1, true, "Should fail on empty object");

    // Null/Undefined (using @ts-ignore for runtime check)
    // @ts-ignore
    const res2 = await posting.createPost({ author: authorA, content: null });
    assertEquals("error" in res2, true, "Should fail on null");

    // Partial success (only type/metadata provided, but no content)
    const res3 = await posting.createPost({ author: authorA, content: {}, type: "test" });
    assertEquals("error" in res3, true, "Should fail if content is empty even if type is present");
  } finally {
    await client.close();
  }
});

Deno.test("Action: editPost - Authorization and Existence", async () => {
  const [db, client] = await testDb();
  const posting = new PostingConcept(db);
  try {
    const createRes = await posting.createPost({ author: authorA, content: { text: "C" } });
    const postId = (createRes as { postId: string }).postId;

    // Wrong author
    const res1 = await posting.editPost({ postId, author: authorB, content: { text: "B's edit" } });
    assertEquals("error" in res1, true, "Should fail for wrong author");

    // Non-existent ID (valid ObjectId format)
    const nonExistentId = "012345678901234567890123";
    const res2 = await posting.editPost({ postId: nonExistentId, author: authorA, content: { text: "X" } });
    assertEquals("error" in res2, true, "Should fail for non-existent post");

    // Invalid ID format
    const res3 = await posting.editPost({ postId: "invalid-id", author: authorA, content: { text: "X" } });
    assertEquals("error" in res3, true, "Should fail for invalid ID format");

    // Empty content update
    const res4 = await posting.editPost({ postId, author: authorA, content: {} });
    assertEquals("error" in res4, true, "Should fail on empty content update");
  } finally {
    await client.close();
  }
});

Deno.test("Action: deletePost - Authorization and Existence", async () => {
  const [db, client] = await testDb();
  const posting = new PostingConcept(db);
  try {
    const createRes = await posting.createPost({ author: authorA, content: { text: "C" } });
    const postId = (createRes as { postId: string }).postId;

    // Wrong author
    const res1 = await posting.deletePost({ postId, author: authorB });
    assertEquals("error" in res1, true, "Should fail for wrong author");

    // Non-existent ID
    const nonExistentId = "012345678901234567890123";
    const res2 = await posting.deletePost({ postId: nonExistentId, author: authorA });
    assertEquals("error" in res2, true, "Should fail for non-existent post");

    // Invalid ID
    const res3 = await posting.deletePost({ postId: "invalid", author: authorA });
    assertEquals("error" in res3, true, "Should fail for invalid ID format");
  } finally {
    await client.close();
  }
});

Deno.test("Queries: Retrieval and Filtering", async () => {
  const [db, client] = await testDb();
  const posting = new PostingConcept(db);
  try {
    // Setup data
    await posting.createPost({ author: authorA, content: { n: 1 }, type: "type1" });
    await new Promise(r => setTimeout(r, 10));
    await posting.createPost({ author: authorA, content: { n: 2 }, type: "type2" });
    await new Promise(r => setTimeout(r, 10));
    await posting.createPost({ author: authorB, content: { n: 3 }, type: "type1" });

    // _getPostsByAuthor (Sorting: latest first)
    const authorAFrames = await posting._getPostsByAuthor({ author: authorA });
    const postsA = authorAFrames[0].posts;
    assertEquals(postsA.length, 2);
    assertEquals(postsA[0].content.n, 2, "Latest post should be first");
    assertEquals(postsA[1].content.n, 1);

    // _getPostsByType
    const type1Frames = await posting._getPostsByType({ type: "type1" });
    const postsType1 = type1Frames[0].posts;
    assertEquals(postsType1.length, 2);
    assertEquals(postsType1[0].author, authorB, "Latest (author B) should be first");

    // _allPosts
    const allFrames = await posting._allPosts();
    assertEquals(allFrames[0].posts.length >= 3, true);

    // _getPost with invalid ID should return null post
    const nullArr = await posting._getPost({ postId: "invalid-id" });
    assertEquals(nullArr[0].post, null);

  } finally {
    await client.close();
  }
});
