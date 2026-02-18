import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import CommentingConcept, { Item, Author } from "./CommentingConcept.ts";

const authorA = "user:Alice" as Author;
const authorB = "user:Bob" as Author;
const itemX = "item:X" as Item;

Deno.test({
  name: "Principle: user posts, edits, and deletes a comment",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
  },
});

Deno.test({
  name: "Action: editComment enforces author check",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
  },
});

Deno.test({
  name: "Lifecycle: deleteByAuthor and deleteByItem",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const commenting = new CommentingConcept(db);
    try {
      await commenting.postComment({ item: itemX, author: authorA, content: "Alice 1" });
      await commenting.postComment({ item: itemX, author: authorB, content: "Bob 1" });
      const itemY = "item:Y" as Item;
      await commenting.postComment({ item: itemY, author: authorA, content: "Alice on Y" });

      await commenting.deleteByAuthor({ author: authorA });
      const commentsX = await commenting._getComments({ item: itemX });
      assertEquals(commentsX[0].comments.length, 1);
      assertEquals(commentsX[0].comments[0].content, "Bob 1");
      const commentsY = await commenting._getComments({ item: itemY });
      assertEquals(commentsY[0].comments.length, 0);

      await commenting.deleteByItem({ item: itemX });
      const commentsXAfter = await commenting._getComments({ item: itemX });
      assertEquals(commentsXAfter[0].comments.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Query: _getComments returns comments for an item in order",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
  },
});

Deno.test({
  name: "Query: _getCommentsByIds preserves input order and omits missing IDs",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const commenting = new CommentingConcept(db);
    try {
      const c1 = await commenting.postComment({
        item: itemX,
        author: authorA,
        content: "First by A",
      });
      const c2 = await commenting.postComment({
        item: itemX,
        author: authorB,
        content: "Second by B",
      });

      const id1 = (c1 as { commentId: string }).commentId;
      const id2 = (c2 as { commentId: string }).commentId;

      const res = await commenting._getCommentsByIds({
        commentIds: [id2, "missing-comment-id", id1],
      });

      assertEquals(res[0].comments.length, 2);
      assertEquals(res[0].comments[0]._id, id2 as ID);
      assertEquals(res[0].comments[0].content, "Second by B");
      assertEquals(res[0].comments[1]._id, id1 as ID);
      assertEquals(res[0].comments[1].content, "First by A");
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Query: _getCommentsByItems returns groups in input order",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const commenting = new CommentingConcept(db);
    try {
      const itemY = "item:Y" as Item;
      const itemZ = "item:Z" as Item;

      await commenting.postComment({
        item: itemX,
        author: authorA,
        content: "X-1",
      });
      await commenting.postComment({
        item: itemY,
        author: authorB,
        content: "Y-1",
      });
      await commenting.postComment({
        item: itemX,
        author: authorB,
        content: "X-2",
      });

      const res = await commenting._getCommentsByItems({
        items: [itemY, itemZ, itemX],
      });
      const groups = res[0].groups;

      assertEquals(groups.length, 3);
      assertEquals(groups[0].item, itemY);
      assertEquals(groups[0].comments.length, 1);
      assertEquals(groups[0].comments[0].content, "Y-1");

      assertEquals(groups[1].item, itemZ);
      assertEquals(groups[1].comments.length, 0);

      assertEquals(groups[2].item, itemX);
      assertEquals(groups[2].comments.length, 2);
      assertEquals(groups[2].comments[0].content, "X-1");
      assertEquals(groups[2].comments[1].content, "X-2");
    } finally {
      await client.close();
    }
  },
});
