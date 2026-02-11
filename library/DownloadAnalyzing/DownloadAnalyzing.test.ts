import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import DownloadAnalyzingConcept, { Item, User } from "./DownloadAnalyzingConcept.ts";

const userA = "user:Alice" as User;
const userB = "user:Bob" as User;
const itemX = "item:X" as Item;
const itemY = "item:Y" as Item;

Deno.test("Principle: record downloads and analyze counts", async () => {
  const [db, client] = await testDb();
  const da = new DownloadAnalyzingConcept(db);
  try {
    const now = new Date();
    // Record three downloads for itemX by two users
    // Times: T-10s, T-5s, T
    const t1 = new Date(now.getTime() - 10_000);
    const t2 = new Date(now.getTime() - 5_000);
    const t3 = now;

    const r1 = await da.record({ item: itemX, user: userA, at: t1 });
    assertEquals(r1, { ok: true });
    
    const r2 = await da.record({ item: itemX, user: userB, at: t2 });
    assertEquals(r2, { ok: true });
    
    const r3 = await da.record({ item: itemX, user: userA, at: t3 });
    assertEquals(r3, { ok: true });
    
    // Count in full window
    // from T-20s to T+1s
    const from = new Date(now.getTime() - 20_000);
    const to = new Date(now.getTime() + 1_000);
    const countArr = await da._countForItem({ item: itemX, from, to });
    assertEquals(countArr[0].count, 3);
    
    // Count in partial window (only last one)
    // from T-2s to T+1s
    const recentFrom = new Date(now.getTime() - 2_000);
    const countRecent = await da._countForItem({ item: itemX, from: recentFrom, to });
    assertEquals(countRecent[0].count, 1);

    // Count in empty window (before any)
    const ancientFrom = new Date(now.getTime() - 100_000);
    const ancientTo = new Date(now.getTime() - 50_000);
    const countAncient = await da._countForItem({ item: itemX, from: ancientFrom, to: ancientTo });
    assertEquals(countAncient[0].count, 0);

  } finally {
    await client.close();
  }
});

Deno.test("Query: _countForItem zero for non-existent item", async () => {
  const [db, client] = await testDb();
  const da = new DownloadAnalyzingConcept(db);
  try {
    const now = new Date();
    const arr = await da._countForItem({ item: itemY, from: now, to: now });
    assertEquals(arr[0].count, 0);
  } finally {
    await client.close();
  }
});

Deno.test("Action: record returns error when item is missing", async () => {
  const [db, client] = await testDb();
  const da = new DownloadAnalyzingConcept(db);
  try {
    const res = await da.record({ user: userA, at: new Date() });
    assertEquals("error" in res, true);
    if ("error" in res) assertEquals(res.error, "Item is required");
  } finally {
    await client.close();
  }
});

Deno.test("Lifecycle: deleteByItem removes all downloads for item", async () => {
  const [db, client] = await testDb();
  const da = new DownloadAnalyzingConcept(db);
  try {
    const now = new Date();
    await da.record({ item: itemX, user: userA, at: now });
    await da.record({ item: itemX, user: userB, at: now });
    const before = await da._countForItem({ item: itemX });
    assertEquals(before[0].count, 2);

    await da.deleteByItem({ item: itemX });
    const after = await da._countForItem({ item: itemX });
    assertEquals(after[0].count, 0);
  } finally {
    await client.close();
  }
});

Deno.test("Lifecycle: deleteByUser removes user's downloads from all items", async () => {
  const [db, client] = await testDb();
  const da = new DownloadAnalyzingConcept(db);
  try {
    const now = new Date();
    await da.record({ item: itemX, user: userA, at: now });
    await da.record({ item: itemX, user: userB, at: now });
    await da.record({ item: itemY, user: userA, at: now });

    await da.deleteByUser({ user: userA });

    const countX = await da._countForItem({ item: itemX });
    const countY = await da._countForItem({ item: itemY });
    assertEquals(countX[0].count, 1);
    assertEquals(countY[0].count, 0);
  } finally {
    await client.close();
  }
});
