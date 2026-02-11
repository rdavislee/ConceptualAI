import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ExpiringConcept, { Item } from "./ExpiringConcept.ts";

const item1 = "post:1" as Item;
const item2 = "post:2" as Item;

Deno.test("Expiring: Basic lifecycle", async () => {
  const [db, client] = await testDb();
  const expiring = new ExpiringConcept(db);
  try {
    // 1. Set future expiry
    const future = new Date(Date.now() + 10000);
    await expiring.setExpiry({ item: item1, expiresAt: future });

    // 2. Verify not expired
    const res1 = await expiring._isExpired({ item: item1 });
    assertEquals(res1[0].expired, false);

    // 3. Set past expiry (via setExpiry error check)
    const err = await expiring.setExpiry({ item: item2, expiresAt: new Date(Date.now() - 1000) });
    assertEquals("error" in err, true);

    // 4. Manually trigger expired state in DB for testing
    // (We'll use a very short timeout instead)
    await expiring.setExpiry({ item: item2, expiresAt: new Date(Date.now() + 10) });
    await new Promise(r => setTimeout(r, 20));

    const res2 = await expiring._isExpired({ item: item2 });
    assertEquals(res2[0].expired, true);

    const expiredItems = await expiring._getExpiredItems();
    assertEquals(expiredItems[0].items.includes(item2), true);

    // 5. Check remaining time
    const remaining = await expiring._getRemainingTime({ item: item1 });
    assertEquals(remaining[0].remainingMs > 0, true);

    // 6. Cancel
    await expiring.cancelExpiry({ item: item1 });
    const res3 = await expiring._isExpired({ item: item1 });
    assertEquals(res3[0].expired, false, "Should be false if no expiry record exists");
    const remainingAfter = await expiring._getRemainingTime({ item: item1 });
    assertEquals(remainingAfter[0].remainingMs, 0);

  } finally {
    await client.close();
  }
});

Deno.test("Expiring: Edge Cases", async () => {
  const [db, client] = await testDb();
  const expiring = new ExpiringConcept(db);
  try {
    // Cancel non-existent
    const err = await expiring.cancelExpiry({ item: item1 });
    assertEquals("error" in err, true);
  } finally {
    await client.close();
  }
});

Deno.test("Expiring: deleteByItem removes expiry record", async () => {
  const [db, client] = await testDb();
  const expiring = new ExpiringConcept(db);
  try {
    await expiring.setExpiry({ item: item1, expiresAt: new Date(Date.now() + 10000) });
    const before = await expiring._isExpired({ item: item1 });
    assertEquals(before[0].expired, false);

    await expiring.deleteByItem({ item: item1 });
    const after = await expiring._isExpired({ item: item1 });
    assertEquals(after[0].expired, false);
    const remaining = await expiring._getRemainingTime({ item: item1 });
    assertEquals(remaining[0].remainingMs, 0);
  } finally {
    await client.close();
  }
});
