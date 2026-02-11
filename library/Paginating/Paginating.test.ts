import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import PaginatingConcept, {
  Item,
  List,
  ScopeID,
  ScopeType,
} from "./PaginatingConcept.ts";

const userScopeA = "user:ownerA" as ScopeID;
const userScopeB = "user:ownerB" as ScopeID;
const postScopeX = "post:scopeX" as ScopeID;
const groupScopeG = "group:chatG" as ScopeID;

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
  scopeType: ScopeType;
  scopeID?: ScopeID;
  itemType: string;
  items: Item[];
}

function expectListIdResult(result: { list: List } | { error: string }): List {
  assertEquals("list" in result, true, "Expected list creation to succeed");
  return (result as { list: List }).list;
}

function expectPageResult(result: PageFrame | { error: string }): PageFrame {
  assertEquals("error" in result, false, "Expected page query to succeed");
  return result as PageFrame;
}

Deno.test({
  name: "Principle: user-scoped post feed returns paged IDs in createdAt mode",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      const listRes = await paginating.createList({
        scopeType: "user",
        scopeID: userScopeA,
        itemType: "post",
        pageSize: 2,
        mode: "createdAt",
      });
      const list = expectListIdResult(listRes);

      await paginating.upsertEntry({ list, item: itemA, createdAt: t1, score: 10 });
      await paginating.upsertEntry({ list, item: itemB, createdAt: t2, score: 5 });
      await paginating.upsertEntry({ list, item: itemC, createdAt: t3, score: 1 });

      const page1 = await paginating._getPage({ list, page: 1 });
      const p1 = expectPageResult(page1[0]);
      assertEquals(p1.items, [itemC, itemB]);
      assertEquals(p1.mode, "createdAt");
      assertEquals(p1.pageSize, 2);
      assertEquals(p1.totalItems, 3);
      assertEquals(p1.totalPages, 2);
      assertEquals(p1.scopeType, "user");
      assertEquals(p1.scopeID, userScopeA);
      assertEquals(p1.itemType, "post");

      const page2 = await paginating._getPage({ list, page: 2 });
      const p2 = expectPageResult(page2[0]);
      assertEquals(p2.items, [itemA]);

      const listsForScope = await paginating._getListsByScope({
        scopeType: "user",
        scopeID: userScopeA,
        itemType: "post",
      });
      assertEquals("lists" in listsForScope[0], true);
      assertEquals(
        (listsForScope[0] as { lists: List[] }).lists.includes(list),
        true,
      );
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Mode: score sorting uses createdAt as tie-breaker",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      const listRes = await paginating.createList({
        scopeType: "user",
        scopeID: userScopeA,
        itemType: "post",
        pageSize: 10,
        mode: "score",
      });
      const list = expectListIdResult(listRes);

      // Same score for A/B, tie-break by createdAt (newer first).
      await paginating.upsertEntry({ list, item: itemA, createdAt: t1, score: 100 });
      await paginating.upsertEntry({ list, item: itemB, createdAt: t2, score: 100 });
      await paginating.upsertEntry({ list, item: itemC, createdAt: t3, score: 10 });

      const page = await paginating._getPage({ list, page: 1 });
      const p = expectPageResult(page[0]);
      assertEquals(p.items, [itemB, itemA, itemC]);
      assertEquals(p.mode, "score");
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Actions: setMode and setEntryScore affect retrieval order",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      const listRes = await paginating.createList({
        scopeType: "user",
        scopeID: userScopeA,
        itemType: "post",
        pageSize: 10,
        mode: "createdAt",
      });
      const list = expectListIdResult(listRes);

      await paginating.upsertEntry({ list, item: itemA, createdAt: t1, score: 100 });
      await paginating.upsertEntry({ list, item: itemB, createdAt: t3, score: 1 });

      const byDate = await paginating._getPage({ list, page: 1 });
      assertEquals(expectPageResult(byDate[0]).items, [itemB, itemA]);

      const setModeRes = await paginating.setMode({ list, mode: "score" });
      assertEquals("ok" in setModeRes, true);

      const byScore = await paginating._getPage({ list, page: 1 });
      assertEquals(expectPageResult(byScore[0]).items, [itemA, itemB]);

      const scoreRes = await paginating.setEntryScore({ list, item: itemB, score: 1000 });
      assertEquals("ok" in scoreRes, true);

      const byUpdatedScore = await paginating._getPage({ list, page: 1 });
      assertEquals(expectPageResult(byUpdatedScore[0]).items, [itemB, itemA]);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Lifecycle: deleteByItem and deleteByScope clean up correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      const listARes = await paginating.createList({
        scopeType: "user",
        scopeID: userScopeA,
        itemType: "post",
        pageSize: 10,
        mode: "createdAt",
      });
      const listBRes = await paginating.createList({
        scopeType: "post",
        scopeID: postScopeX,
        itemType: "comments",
        pageSize: 10,
        mode: "createdAt",
      });
      const listA = expectListIdResult(listARes);
      const listB = expectListIdResult(listBRes);

      await paginating.upsertEntry({ list: listA, item: itemX, createdAt: t1, score: 1 });
      await paginating.upsertEntry({ list: listB, item: itemX, createdAt: t2, score: 1 });
      await paginating.upsertEntry({ list: listB, item: itemY, createdAt: t3, score: 1 });

      const delItemRes = await paginating.deleteByItem({ item: itemX });
      assertEquals(delItemRes.ok, true);
      assertEquals(delItemRes.removed, 2);

      const listAPage = await paginating._getPage({ list: listA, page: 1 });
      assertEquals(expectPageResult(listAPage[0]).items, []);

      const listBPage = await paginating._getPage({ list: listB, page: 1 });
      assertEquals(expectPageResult(listBPage[0]).items, [itemY]);

      const delScopeRes = await paginating.deleteByScope({
        scopeType: "user",
        scopeID: userScopeA,
      });
      assertEquals("ok" in delScopeRes, true);
      assertEquals(("listsRemoved" in delScopeRes) && delScopeRes.listsRemoved, 1);

      const afterDeleteScopePage = await paginating._getPage({ list: listA, page: 1 });
      assertEquals("error" in afterDeleteScopePage[0], true);

      const stillTherePage = await paginating._getPage({ list: listB, page: 1 });
      assertEquals(expectPageResult(stillTherePage[0]).items, [itemY]);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Validation: scopeID rules and pagination constraints",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const paginating = new PaginatingConcept(db);

    try {
      const systemOk = await paginating.createList({
        scopeType: "system",
        itemType: "post",
        pageSize: 20,
      });
      assertEquals("list" in systemOk, true);

      const systemWithID = await paginating.createList({
        scopeType: "system",
        scopeID: userScopeA,
        itemType: "post",
        pageSize: 20,
      });
      assertEquals("error" in systemWithID, true);

      const postWithID = await paginating.createList({
        scopeType: "post",
        scopeID: postScopeX,
        itemType: "comments",
        pageSize: 20,
      });
      assertEquals("list" in postWithID, true);

      const groupWithID = await paginating.createList({
        scopeType: "group",
        scopeID: groupScopeG,
        itemType: "messages",
        pageSize: 20,
      });
      assertEquals("list" in groupWithID, true);

      const groupWithoutID = await paginating.createList({
        scopeType: "group",
        itemType: "messages",
        pageSize: 20,
      });
      assertEquals("error" in groupWithoutID, true);

      const badList = await paginating.createList({
        scopeType: "user",
        scopeID: userScopeB,
        itemType: "post",
        pageSize: 0,
        mode: "createdAt",
      });
      assertEquals("error" in badList, true);

      const goodList = await paginating.createList({
        scopeType: "user",
        scopeID: userScopeB,
        itemType: "post",
        pageSize: 2,
        mode: "createdAt",
      });
      const list = expectListIdResult(goodList);

      const badPage = await paginating._getPage({ list, page: 0 });
      assertEquals("error" in badPage[0], true);

      const badResize = await paginating.setPageSize({ list, pageSize: -5 });
      assertEquals("error" in badResize, true);
    } finally {
      await client.close();
    }
  },
});
