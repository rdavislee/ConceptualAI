import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import FollowingConcept, { Follower, Followed } from "./FollowingConcept.ts";

const userA = "user:Alice" as Follower;
const userB = "user:Bob" as Followed & Follower;
const userC = "user:Charlie" as Followed;

Deno.test("Principle: user follows then unfollows another user", async () => {
  const [db, client] = await testDb();
  const following = new FollowingConcept(db);
  try {
    // A follows B
    const followRes = await following.follow({ follower: userA, followed: userB });
    assertEquals("ok" in followRes, true, "Follow should succeed");

    // Confirm _isFollowing returns true
    const isFollowingArr = await following._isFollowing({ follower: userA, followed: userB });
    assertEquals(isFollowingArr[0].following, true);

    // Attempt duplicate follow (should error)
    const dupRes = await following.follow({ follower: userA, followed: userB });
    assertEquals("error" in dupRes, true, "Duplicate follow should fail");

    // Unfollow
    const unfollowRes = await following.unfollow({ follower: userA, followed: userB });
    assertEquals("ok" in unfollowRes, true, "Unfollow should succeed");

    // Confirm not following
    const afterUnfollow = await following._isFollowing({ follower: userA, followed: userB });
    assertEquals(afterUnfollow[0].following, false);
  } finally {
    await client.close();
  }
});

Deno.test("Action: follow enforces no self-following", async () => {
  const [db, client] = await testDb();
  const following = new FollowingConcept(db);
  try {
    const res = await following.follow({ follower: userA, followed: userA as unknown as Followed });
    assertEquals("error" in res, true, "Self-following should fail");
  } finally {
    await client.close();
  }
});

Deno.test("Action: unfollow requires existing relationship", async () => {
  const [db, client] = await testDb();
  const following = new FollowingConcept(db);
  try {
    const res = await following.unfollow({ follower: userA, followed: userB });
    assertEquals("error" in res, true, "Unfollowing without following should fail");
  } finally {
    await client.close();
  }
});

Deno.test("Query: _followers reflects number of followers", async () => {
  const [db, client] = await testDb();
  const following = new FollowingConcept(db);
  try {
    // Initially zero
    const initial = await following._followers({ followed: userB });
    assertEquals(initial[0].users.length, 0);

    // Add two distinct followers for B
    await following.follow({ follower: userA, followed: userB });
    await following.follow({ follower: userB, followed: userC }); // B follows C

    const followersB = await following._followers({ followed: userB });
    assertEquals(followersB[0].users.length, 1);
    assertEquals(followersB[0].users[0], userA);

    const followersC = await following._followers({ followed: userC });
    assertEquals(followersC[0].users.length, 1);
    assertEquals(followersC[0].users[0], userB);
  } finally {
    await client.close();
  }
});

Deno.test("Query: _following returns set of users followed by a user", async () => {
  const [db, client] = await testDb();
  const following = new FollowingConcept(db);
  try {
    // User A follows B and C
    await following.follow({ follower: userA, followed: userB });
    await following.follow({ follower: userA, followed: userC });

    const followingA = await following._following({ follower: userA });
    assertEquals(followingA[0].users.length, 2);
    assertEquals(followingA[0].users.includes(userB), true);
    assertEquals(followingA[0].users.includes(userC), true);
  } finally {
    await client.close();
  }
});

Deno.test("Query: _getFollowerCount returns correct count", async () => {
  const [db, client] = await testDb();
  const following = new FollowingConcept(db);
  try {
    // Initially zero
    const ini = await following._getFollowerCount({ followed: userB });
    assertEquals(ini[0].count, 0);

    // Follow
    await following.follow({ follower: userA, followed: userB });
    const one = await following._getFollowerCount({ followed: userB });
    assertEquals(one[0].count, 1);

    // Another follow
    await following.follow({ follower: userC, followed: userB });
    const two = await following._getFollowerCount({ followed: userB });
    assertEquals(two[0].count, 2);

    // Unfollow
    await following.unfollow({ follower: userA, followed: userB });
    const oneAgain = await following._getFollowerCount({ followed: userB });
    assertEquals(oneAgain[0].count, 1);
  } finally {
    await client.close();
  }
});

Deno.test("Query: _getFollowingCount returns correct count", async () => {
  const [db, client] = await testDb();
  const following = new FollowingConcept(db);
  try {
    // Initially zero
    const ini = await following._getFollowingCount({ follower: userA });
    assertEquals(ini[0].count, 0);

    // Follow
    await following.follow({ follower: userA, followed: userB });
    const one = await following._getFollowingCount({ follower: userA });
    assertEquals(one[0].count, 1);

    // Follow another
    await following.follow({ follower: userA, followed: userC });
    const two = await following._getFollowingCount({ follower: userA });
    assertEquals(two[0].count, 2);
  } finally {
    await client.close();
  }
});
