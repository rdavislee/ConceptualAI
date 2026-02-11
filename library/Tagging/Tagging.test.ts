import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import TaggingConcept, { Item, Owner } from "./TaggingConcept.ts";

const itemX = "item:X" as Item;
const itemY = "item:Y" as Item;
const user1 = "user:1" as Owner;
const user2 = "user:2" as Owner;

Deno.test("Tagging: Global tags (no owner)", async () => {
  const [db, client] = await testDb();
  const tagging = new TaggingConcept(db);
  try {
    // Add global tag
    await tagging.addTag({ item: itemX, tag: "science" });

    // Verify tag exists
    const tags = await tagging._getTags({ item: itemX });
    assertEquals(tags[0].tags.length, 1);
    assertEquals(tags[0].tags[0].name, "science");
    assertEquals(tags[0].tags[0].owner, undefined);

    // Verify items with tag
    const items = await tagging._getItemsWithTag({ tag: "science" });
    assertEquals(items[0].items.includes(itemX), true);

    // Remove tag
    await tagging.removeTag({ item: itemX, tag: "science" });
    const afterRemove = await tagging._getTags({ item: itemX });
    assertEquals(afterRemove[0].tags.length, 0);

  } finally {
    await client.close();
  }
});

Deno.test("Tagging: User-specific tags (with owner)", async () => {
  const [db, client] = await testDb();
  const tagging = new TaggingConcept(db);
  try {
    // User1 creates a "work" tag
    await tagging.addTag({ item: itemX, tag: "work", owner: user1 });

    // User2 creates a different "work" tag
    await tagging.addTag({ item: itemY, tag: "work", owner: user2 });

    // Verify user1's work tag
    const tags1 = await tagging._getTags({ item: itemX });
    assertEquals(tags1[0].tags.length, 1);
    assertEquals(tags1[0].tags[0].name, "work");
    assertEquals(tags1[0].tags[0].owner, user1);

    // Verify user2's work tag
    const tags2 = await tagging._getTags({ item: itemY });
    assertEquals(tags2[0].tags.length, 1);
    assertEquals(tags2[0].tags[0].name, "work");
    assertEquals(tags2[0].tags[0].owner, user2);

    // Query by owner
    const user1Tags = await tagging._getTagsByOwner({ owner: user1 });
    assertEquals(user1Tags[0].tags.length, 1);
    assertEquals(user1Tags[0].tags[0].name, "work");

    // Query items with user1's "work" tag
    const items1 = await tagging._getItemsWithTag({ tag: "work", owner: user1 });
    assertEquals(items1[0].items.length, 1);
    assertEquals(items1[0].items[0], itemX);

    // Query items with user2's "work" tag (different namespace)
    const items2 = await tagging._getItemsWithTag({ tag: "work", owner: user2 });
    assertEquals(items2[0].items.length, 1);
    assertEquals(items2[0].items[0], itemY);

  } finally {
    await client.close();
  }
});

Deno.test("Tagging: Mixed global and owned tags", async () => {
  const [db, client] = await testDb();
  const tagging = new TaggingConcept(db);
  try {
    // Add both global and owned tags to same item
    await tagging.addTag({ item: itemX, tag: "public" });
    await tagging.addTag({ item: itemX, tag: "private", owner: user1 });

    const tags = await tagging._getTags({ item: itemX });
    assertEquals(tags[0].tags.length, 2);

    const publicTag = tags[0].tags.find((t) => t.name === "public");
    assertEquals(publicTag?.owner, undefined);

    const privateTag = tags[0].tags.find((t) => t.name === "private");
    assertEquals(privateTag?.owner, user1);

  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Tagging: removeAllTags",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const tagging = new TaggingConcept(db);
    try {
      await tagging.addTag({ item: itemX, tag: "tag1" });
      await tagging.addTag({ item: itemX, tag: "tag2", owner: user1 });

      await tagging.removeAllTags({ item: itemX });

      const tags = await tagging._getTags({ item: itemX });
      assertEquals(tags[0].tags.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test("Tagging: Edge cases", async () => {
  const [db, client] = await testDb();
  const tagging = new TaggingConcept(db);
  try {
    // Empty tag
    const err1 = await tagging.addTag({ item: itemX, tag: "   " });
    assertEquals("error" in err1, true);

    // Duplicate tag
    await tagging.addTag({ item: itemX, tag: "dup", owner: user1 });
    const err2 = await tagging.addTag({ item: itemX, tag: "dup", owner: user1 });
    assertEquals("error" in err2, true);

    // Remove non-existent
    const err3 = await tagging.removeTag({ item: itemY, tag: "missing" });
    assertEquals("error" in err3, true);

  } finally {
    await client.close();
  }
});
