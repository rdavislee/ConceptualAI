import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import BlockingConcept, { User } from "./BlockingConcept.ts";

const alice = "user:Alice" as User;
const bob = "user:Bob" as User;
const charlie = "user:Charlie" as User;

Deno.test("Blocking: Basic lifecycle", async () => {
  const [db, client] = await testDb();
  const blocking = new BlockingConcept(db);
  try {
    // 1. Block
    await blocking.block({ blocker: alice, blocked: bob });

    // 2. Query blocked users
    const list = await blocking._getBlockedUsers({ blocker: alice });
    assertEquals(list[0].users.length, 1);
    assertEquals(list[0].users[0], bob);

    // 3. Check mutual block status
    const res1 = await blocking._isBlocked({ userA: alice, userB: bob });
    assertEquals(res1[0].blocked, true);

    const res2 = await blocking._isBlocked({ userA: bob, userB: alice });
    assertEquals(res2[0].blocked, true, "Should be blocked if either party blocked the other");

    const res3 = await blocking._isBlocked({ userA: alice, userB: charlie });
    assertEquals(res3[0].blocked, false);

    // 4. Unblock
    await blocking.unblock({ blocker: alice, blocked: bob });
    const resFinal = await blocking._isBlocked({ userA: alice, userB: bob });
    assertEquals(resFinal[0].blocked, false);

  } finally {
    await client.close();
  }
});

Deno.test("Blocking: Edge Cases", async () => {
  const [db, client] = await testDb();
  const blocking = new BlockingConcept(db);
  try {
    // Block self
    const err1 = await blocking.block({ blocker: alice, blocked: alice });
    assertEquals("error" in err1, true);

    // Double block
    await blocking.block({ blocker: alice, blocked: bob });
    const err2 = await blocking.block({ blocker: alice, blocked: bob });
    assertEquals("error" in err2, true);

    // Unblock non-existent
    const err3 = await blocking.unblock({ blocker: bob, blocked: alice });
    assertEquals("error" in err3, true);

    // deleteByBlocker and deleteByBlocked
    await blocking.block({ blocker: alice, blocked: bob });
    await blocking.block({ blocker: bob, blocked: charlie });
    await blocking.deleteByBlocker({ blocker: alice });
    const listAfter = await blocking._getBlockedUsers({ blocker: alice });
    assertEquals(listAfter[0].users.length, 0);
    const bobList = await blocking._getBlockedUsers({ blocker: bob });
    assertEquals(bobList[0].users.length, 1);

    await blocking.deleteByBlocked({ blocked: charlie });
    const bobListFinal = await blocking._getBlockedUsers({ blocker: bob });
    assertEquals(bobListFinal[0].users.length, 0);

  } finally {
    await client.close();
  }
});
