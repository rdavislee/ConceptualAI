import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import AccessingConcept, { Subject, Target } from "./AccessingConcept.ts";

const sub1 = "user:1" as Subject;
const sub2 = "user:2" as Subject;
const target1 = "item:1" as Target;

Deno.test("Accessing: Basic roles and permissions", async () => {
  const [db, client] = await testDb();
  const accessing = new AccessingConcept(db);
  try {
    // 1. Grant viewer access
    await accessing.grantAccess({ subject: sub1, target: target1, role: "viewer" });

    // 2. Check access
    const res1 = await accessing._getAccess({ subject: sub1, target: target1 });
    assertEquals(res1[0].role, "viewer");

    const hasViewer = await accessing._hasAccess({ subject: sub1, target: target1, requiredRole: "viewer" });
    assertEquals(hasViewer[0].hasAccess, true);

    const hasEditor = await accessing._hasAccess({ subject: sub1, target: target1, requiredRole: "editor" });
    assertEquals(hasEditor[0].hasAccess, false);

    // 3. Upgrade to editor
    await accessing.grantAccess({ subject: sub1, target: target1, role: "editor" });
    const hasEditor2 = await accessing._hasAccess({ subject: sub1, target: target1, requiredRole: "editor" });
    assertEquals(hasEditor2[0].hasAccess, true);

    const hasViewer2 = await accessing._hasAccess({ subject: sub1, target: target1, requiredRole: "viewer" });
    assertEquals(hasViewer2[0].hasAccess, true);

    // 4. Revoke
    await accessing.revokeAccess({ subject: sub1, target: target1 });
    const res2 = await accessing._getAccess({ subject: sub1, target: target1 });
    assertEquals(res2[0].role, null);

    const hasViewer3 = await accessing._hasAccess({ subject: sub1, target: target1, requiredRole: "viewer" });
    assertEquals(hasViewer3[0].hasAccess, false);

  } finally {
    await client.close();
  }
});

Deno.test("Accessing: Edge Cases", async () => {
  const [db, client] = await testDb();
  const accessing = new AccessingConcept(db);
  try {
    // Invalid role
    const err = await accessing.grantAccess({ subject: sub1, target: target1, role: "admin" });
    assertEquals("error" in err, true);

    // Revoke non-existent
    const err2 = await accessing.revokeAccess({ subject: sub2, target: target1 });
    assertEquals("error" in err2, true);

    // Access for non-existent user on item
    const res = await accessing._getAccess({ subject: sub2, target: target1 });
    assertEquals(res[0].role, null);

  } finally {
    await client.close();
  }
});

Deno.test("Accessing: deleteBySubject and deleteByTarget lifecycle", async () => {
  const [db, client] = await testDb();
  const accessing = new AccessingConcept(db);
  try {
    const target2 = "item:2" as Target;
    await accessing.grantAccess({ subject: sub1, target: target1, role: "viewer" });
    await accessing.grantAccess({ subject: sub1, target: target2, role: "editor" });
    await accessing.grantAccess({ subject: sub2, target: target1, role: "owner" });

    // deleteBySubject removes all rules for sub1
    await accessing.deleteBySubject({ subject: sub1 });
    assertEquals((await accessing._getAccess({ subject: sub1, target: target1 }))[0].role, null);
    assertEquals((await accessing._getAccess({ subject: sub1, target: target2 }))[0].role, null);
    assertEquals((await accessing._getAccess({ subject: sub2, target: target1 }))[0].role, "owner");

    // deleteByTarget removes remaining rules for target1
    await accessing.deleteByTarget({ target: target1 });
    assertEquals((await accessing._getAccess({ subject: sub2, target: target1 }))[0].role, null);

  } finally {
    await client.close();
  }
});
