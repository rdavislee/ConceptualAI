import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import PaginatingConcept, {
  Bound,
  Item,
  SortMode,
} from "./PaginatingConcept.ts";

const userBoundA = "user:ownerA" as Bound;
const userBoundB = "user:ownerB" as Bound;
const postBoundX = "post:scopeX" as Bound;

const itemA = "item:A" as Item;
const itemB = "item:B" as Item;
const itemC = "item:C" as Item;
const itemX = "item:X" as Item;
const itemY = "item:Y" as Item;

const t1 = new Date("2026-01-01T00:00:00.000Z");
const t2 = new Date("2026-01-02T00:00:00.000Z");
const t3 = new Date("2026-01-03T00:00:00.000Z");

interface PageFrame {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  mode: "createdAt" | "score";
  bound: Bound;
  itemType: string;
  items: Item[];
}

function expectPageResult(result: PageFrame | { error: string }): PageFrame {
  assertEquals("error" in result, false, "Expected page query to succeed");
  return result as PageFrame;
}

Deno.test({
  name:
    "Principle: bound user feed returns paged IDs with implicit list creation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "feed",
        item: itemA,
        createdAt: t1,
        score: 10,
        mode: "createdAt",
      });
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "feed",
        item: itemB,
        createdAt: t2,
        score: 5,
      });
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "feed",
        item: itemC,
        createdAt: t3,
        score: 1,
      });

      const page1 = await paginating._getPage({
        bound: userBoundA,
        itemType: "feed",
        page: 1,
        pageSize: 2,
      });
      const p1 = expectPageResult(page1[0]);
      assertEquals(p1.items, [itemC, itemB]);
      assertEquals(p1.mode, "createdAt");
      assertEquals(p1.pageSize, 2);
      assertEquals(p1.totalItems, 3);
      assertEquals(p1.totalPages, 2);
      assertEquals(p1.bound, userBoundA);
      assertEquals(p1.itemType, "feed");

      const page2 = await paginating._getPage({
        bound: userBoundA,
        itemType: "feed",
        page: 2,
        pageSize: 2,
      });
      const p2 = expectPageResult(page2[0]);
      assertEquals(p2.items, [itemA]);

      const listsForBound = await paginating._getListsByBound({
        bound: userBoundA,
        itemType: "feed",
      });
      assertEquals("lists" in listsForBound[0], true);
      assertEquals(
        (listsForBound[0] as { lists: { bound: Bound; itemType: string }[] })
          .lists,
        [{
          bound: userBoundA,
          itemType: "feed",
        }],
      );
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name:
    "Mode: score sorting uses createdAt as tie-breaker and setMode auto-creates",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      const setModeRes = await paginating.setMode({
        bound: userBoundA,
        itemType: "feed",
        mode: "score",
      });
      assertEquals("ok" in setModeRes, true);

      // Same score for A/B, tie-break by createdAt (newer first).
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "feed",
        item: itemA,
        createdAt: t1,
        score: 100,
      });
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "feed",
        item: itemB,
        createdAt: t2,
        score: 100,
      });
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "feed",
        item: itemC,
        createdAt: t3,
        score: 10,
      });

      const page = await paginating._getPage({
        bound: userBoundA,
        itemType: "feed",
        page: 1,
      });
      const p = expectPageResult(page[0]);
      assertEquals(p.items, [itemB, itemA, itemC]);
      assertEquals(p.mode, "score");
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Actions: getPage pageSize and setEntryScore affect retrieval order",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "myPosts",
        item: itemA,
        createdAt: t1,
        score: 100,
      });
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "myPosts",
        item: itemB,
        createdAt: t3,
        score: 1,
      });

      const byDate = await paginating._getPage({
        bound: userBoundA,
        itemType: "myPosts",
        page: 1,
      });
      assertEquals(expectPageResult(byDate[0]).items, [itemB, itemA]);

      const setModeRes = await paginating.setMode({
        bound: userBoundA,
        itemType: "myPosts",
        mode: "score",
      });
      assertEquals("ok" in setModeRes, true);

      const byScore = await paginating._getPage({
        bound: userBoundA,
        itemType: "myPosts",
        page: 1,
      });
      assertEquals(expectPageResult(byScore[0]).items, [itemA, itemB]);

      const scoreRes = await paginating.setEntryScore({
        bound: userBoundA,
        itemType: "myPosts",
        item: itemB,
        score: 1000,
      });
      assertEquals("ok" in scoreRes, true);

      const byUpdatedScore = await paginating._getPage({
        bound: userBoundA,
        itemType: "myPosts",
        page: 1,
      });
      assertEquals(expectPageResult(byUpdatedScore[0]).items, [itemB, itemA]);

      const resizedPage = await paginating._getPage({
        bound: userBoundA,
        itemType: "myPosts",
        page: 1,
        pageSize: 1,
      });
      const resized = expectPageResult(resizedPage[0]);
      assertEquals(resized.pageSize, 1);
      assertEquals(resized.totalPages, 2);
      assertEquals(resized.items, [itemB]);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Pagination: last page contains n mod pageSize items",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      const n = 23;
      const pageSize = 5;
      const expectedTotalPages = Math.ceil(n / pageSize);
      const expectedLastPageSize = n % pageSize;
      const itemType = "manyPages";

      for (let i = 1; i <= n; i++) {
        await paginating.upsertEntry({
          bound: userBoundA,
          itemType,
          item: `item:bulk:${i}` as Item,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
          mode: i === 1 ? "createdAt" : undefined,
        });
      }

      const firstPage = await paginating._getPage({
        bound: userBoundA,
        itemType,
        page: 1,
        pageSize,
      });
      const first = expectPageResult(firstPage[0]);
      assertEquals(first.totalItems, n);
      assertEquals(first.totalPages, expectedTotalPages);
      assertEquals(first.pageSize, pageSize);
      assertEquals(first.items.length, pageSize);

      const lastPage = await paginating._getPage({
        bound: userBoundA,
        itemType,
        page: expectedTotalPages,
        pageSize,
      });
      const last = expectPageResult(lastPage[0]);
      assertEquals(last.totalItems, n);
      assertEquals(last.totalPages, expectedTotalPages);
      assertEquals(last.pageSize, pageSize);
      assertEquals(last.items.length, expectedLastPageSize);
      assertEquals(last.items, [
        "item:bulk:3" as Item,
        "item:bulk:2" as Item,
        "item:bulk:1" as Item,
      ]);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Lifecycle: deleteByItem and deleteByBound clean up correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      await paginating.upsertEntry({
        bound: userBoundA,
        itemType: "feed",
        item: itemX,
        createdAt: t1,
        score: 1,
      });
      await paginating.upsertEntry({
        bound: postBoundX,
        itemType: "comments",
        item: itemX,
        createdAt: t2,
        score: 1,
      });
      await paginating.upsertEntry({
        bound: postBoundX,
        itemType: "comments",
        item: itemY,
        createdAt: t3,
        score: 1,
      });

      const delItemRes = await paginating.deleteByItem({ item: itemX });
      assertEquals(delItemRes.ok, true);
      assertEquals(delItemRes.removed, 2);

      const userFeed = await paginating._getPage({
        bound: userBoundA,
        itemType: "feed",
        page: 1,
      });
      assertEquals(expectPageResult(userFeed[0]).items, []);

      const postComments = await paginating._getPage({
        bound: postBoundX,
        itemType: "comments",
        page: 1,
      });
      assertEquals(expectPageResult(postComments[0]).items, [itemY]);

      const delBoundRes = await paginating.deleteByBound({ bound: userBoundA });
      assertEquals(delBoundRes.ok, true);
      assertEquals(delBoundRes.listsRemoved, 1);

      const afterDeleteBoundPage = await paginating._getPage({
        bound: userBoundA,
        itemType: "feed",
        page: 1,
      });
      const deletedListPage = expectPageResult(afterDeleteBoundPage[0]);
      assertEquals(deletedListPage.items, []);
      assertEquals(deletedListPage.totalItems, 0);

      const stillTherePage = await paginating._getPage({
        bound: postBoundX,
        itemType: "comments",
        page: 1,
      });
      assertEquals(expectPageResult(stillTherePage[0]).items, [itemY]);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name:
    "Validation: unmade list query returns empty page and invalid params fail",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      const unmadeList = await paginating._getPage({
        bound: userBoundB,
        itemType: "myPosts",
        page: 1,
      });
      const empty = expectPageResult(unmadeList[0]);
      assertEquals(empty.items, []);
      assertEquals(empty.totalItems, 0);
      assertEquals(empty.totalPages, 0);
      assertEquals(empty.pageSize, 20);
      assertEquals(empty.mode, "createdAt");

      await paginating.upsertEntry({
        itemType: "posts",
        item: itemA,
        createdAt: t1,
      });

      const commonByOmission = await paginating._getPage({
        itemType: "posts",
        page: 1,
      });
      const common1 = expectPageResult(commonByOmission[0]);
      assertEquals(common1.bound, "common");
      assertEquals(common1.items, [itemA]);

      const commonByBlank = await paginating._getPage({
        bound: "" as unknown as Bound,
        itemType: "posts",
        page: 1,
      });
      const common2 = expectPageResult(commonByBlank[0]);
      assertEquals(common2.bound, "common");
      assertEquals(common2.items, [itemA]);

      const badMode = await paginating.setMode({
        bound: userBoundB,
        itemType: "myPosts",
        mode: "not-a-mode" as SortMode,
      });
      assertEquals("error" in badMode, true);

      const badPage = await paginating._getPage({
        bound: userBoundB,
        itemType: "myPosts",
        page: 0,
      });
      assertEquals("error" in badPage[0], true);

      const badPageSize = await paginating._getPage({
        bound: userBoundB,
        itemType: "myPosts",
        page: 1,
        pageSize: -5,
      });
      assertEquals("error" in badPageSize[0], true);
    } finally {
      await client.close();
    }
  },
});
