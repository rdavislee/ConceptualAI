import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import CommentingConcept, { Item, Author } from "./CommentingConcept.ts";

const authorA = "user:Alice" as Author;
const authorB = "user:Bob" as Author;
const itemX = "item:X" as Item;

Deno.test("Principle: user posts, edits, and deletes a comment", async () => {
  const [db, client] = await testDb();
  const commenting = new CommentingConcept(db);
  try {
    // Post comment
    const postRes = await commenting.postComment({ item: itemX, author: authorA, content: "Hello world" });
    assertEquals("commentId" in postRes, true, "Post should succeed");
    const commentId = (postRes as { commentId: string }).commentId;

    // Verify count
    const countArr = await commenting._getCommentCount({ item: itemX });
    assertEquals(countArr[0].n, 1);

    // Edit comment
    const editRes = await commenting.editComment({ commentId, author: authorA, newContent: "Updated content" });
    assertEquals("ok" in editRes, true, "Edit should succeed");

    // Verify content
    const commentArr = await commenting._getComment({ commentId });
    assertEquals(commentArr[0].comment?.content, "Updated content");

    // Delete comment
    const deleteRes = await commenting.deleteComment({ commentId, author: authorA });
    assertEquals("ok" in deleteRes, true, "Delete should succeed");

    // Verify count zero
    const countArrFinal = await commenting._getCommentCount({ item: itemX });
    assertEquals(countArrFinal[0].n, 0);
  } finally {
    await client.close();
  }
});

Deno.test("Action: editComment enforces author check", async () => {
  const [db, client] = await testDb();
  const commenting = new CommentingConcept(db);
  try {
    const postRes = await commenting.postComment({ item: itemX, author: authorA, content: "Alice's comment" });
    const commentId = (postRes as { commentId: string }).commentId;

    const editRes = await commenting.editComment({ commentId, author: authorB, newContent: "Bob trying to edit" });
    assertEquals("error" in editRes, true, "Should fail when editing someone else's comment");
  } finally {
    await client.close();
  }
});

Deno.test("Query: _getComments returns comments for an item in order", async () => {
  const [db, client] = await testDb();
  const commenting = new CommentingConcept(db);
  try {
    await commenting.postComment({ item: itemX, author: authorA, content: "First" });
    await commenting.postComment({ item: itemX, author: authorB, content: "Second" });

    const commentsArr = await commenting._getComments({ item: itemX });
    assertEquals(commentsArr[0].comments.length, 2);
    assertEquals(commentsArr[0].comments[0].content, "First");
    assertEquals(commentsArr[0].comments[1].content, "Second");
  } finally {
    await client.close();
  }
});
