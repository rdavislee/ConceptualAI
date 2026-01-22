import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import LikingConcept, { Item, User } from "./LikingConcept.ts";

const userA = "user:Alice" as User;
const userB = "user:Bob" as User;
const itemX = "item:X" as Item;
const itemY = "item:Y" as Item;

Deno.test("Principle: user likes then unlikes an item (binary preference)", async () => {
  const [db, client] = await testDb();
  const liking = new LikingConcept(db);
  try {
    // Like itemX by userA
    const likeRes = await liking.like({ item: itemX, user: userA });
    assertEquals("ok" in likeRes, true, "First like should succeed");

    // Confirm _isLiked returns true
    const likedArr = await liking._isLiked({ item: itemX, user: userA });
    assertEquals(likedArr.length, 1);
    assertEquals(likedArr[0].liked, true);

    // Attempt duplicate like (should error)
    const dupRes = await liking.like({ item: itemX, user: userA });
    assertEquals("error" in dupRes, true, "Duplicate like should fail");

    // Unlike
    const unlikeRes = await liking.unlike({ item: itemX, user: userA });
    assertEquals("ok" in unlikeRes, true, "Unlike should succeed");

    // Confirm not liked
    const afterUnlike = await liking._isLiked({ item: itemX, user: userA });
    assertEquals(afterUnlike[0].liked, false);
  } finally {
    await client.close();
  }
});

Deno.test("Action: like enforces no existing like precondition", async () => {
  const [db, client] = await testDb();
  const liking = new LikingConcept(db);
  try {
    await liking.like({ item: itemY, user: userB });
    const res = await liking.like({ item: itemY, user: userB });
    assertEquals("error" in res, true, "Second like must fail");
  } finally {
    await client.close();
  }
});

Deno.test("Action: unlike requires existing like", async () => {
  const [db, client] = await testDb();
  const liking = new LikingConcept(db);
  try {
    const res = await liking.unlike({ item: itemX, user: userA });
    assertEquals("error" in res, true, "Unliking without like should fail");
  } finally {
    await client.close();
  }
});

Deno.test("Query: _countForItem reflects number of likes", async () => {
  const [db, client] = await testDb();
  const liking = new LikingConcept(db);
  try {
    // Initially zero
    const initial = await liking._countForItem({ item: itemX });
    assertEquals(initial[0].n, 0);

    // Add two distinct user likes
    await liking.like({ item: itemX, user: userA });
    await liking.like({ item: itemX, user: userB });
    const after = await liking._countForItem({ item: itemX });
    assertEquals(after[0].n, 2);

    // Remove one
    await liking.unlike({ item: itemX, user: userA });
    const finalCount = await liking._countForItem({ item: itemX });
    assertEquals(finalCount[0].n, 1);
  } finally {
    await client.close();
  }
});

Deno.test("Query: _likedItems returns set of liked items by user", async () => {
  const [db, client] = await testDb();
  const liking = new LikingConcept(db);
  try {
    // Initially empty
    const initial = await liking._likedItems({ user: userA });
    assertEquals(initial[0].items.length, 0);

    // User likes two items
    await liking.like({ item: itemX, user: userA });
    await liking.like({ item: itemY, user: userA });

    const after = await liking._likedItems({ user: userA });
    assertEquals(after[0].items.length, 2);
    // Check contents (order might vary, so use sort or includes)
    const items = after[0].items;
    assertEquals(items.includes(itemX), true);
    assertEquals(items.includes(itemY), true);

    // Unlike one
    await liking.unlike({ item: itemX, user: userA });

    const final = await liking._likedItems({ user: userA });
    assertEquals(final[0].items.length, 1);
    assertEquals(final[0].items[0], itemY);
  } finally {
    await client.close();
  }
});

Deno.test("Query: _getLikeCountForUser returns correct count", async () => {
  const [db, client] = await testDb();
  const liking = new LikingConcept(db);
  try {
    // Initially zero
    const init = await liking._getLikeCountForUser({ user: userA });
    assertEquals(init[0].n, 0);

    // Like X
    await liking.like({ item: itemX, user: userA });
    const one = await liking._getLikeCountForUser({ user: userA });
    assertEquals(one[0].n, 1);

    // Like Y
    await liking.like({ item: itemY, user: userA });
    const two = await liking._getLikeCountForUser({ user: userA });
    assertEquals(two[0].n, 2);

    // Unlike X
    await liking.unlike({ item: itemX, user: userA });
    const oneAgain = await liking._getLikeCountForUser({ user: userA });
    assertEquals(oneAgain[0].n, 1);
  } finally {
    await client.close();
  }
});
