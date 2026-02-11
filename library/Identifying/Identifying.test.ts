import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import IdentifyingConcept, { User } from "./IdentifyingConcept.ts";

const alice = "user:alice" as User;

Deno.test("Identifying: Role assignment and updates", async () => {
  const [db, client] = await testDb();
  const ident = new IdentifyingConcept(db);
  try {
    // 1. Set initial role
    await ident.setRole({ user: alice, role: "Employee" });

    // 2. Query role
    const q1 = await ident._getRole({ user: alice });
    assertEquals(q1[0].role, "Employee");

    // 3. Update role (replaces previous)
    await ident.setRole({ user: alice, role: "Manager" });
    const q2 = await ident._getRole({ user: alice });
    assertEquals(q2[0].role, "Manager");

    // 4. Verify hasRole
    const hasRole = await ident._hasRole({ user: alice, role: "Manager" });
    assertEquals(hasRole[0].hasRole, true);

    const hasNotRole = await ident._hasRole({ user: alice, role: "Employee" });
    assertEquals(hasNotRole[0].hasRole, false);

  } finally {
    await client.close();
  }
});

Deno.test("Identifying: Remove role", async () => {
  const [db, client] = await testDb();
  const ident = new IdentifyingConcept(db);
  try {
    await ident.setRole({ user: alice, role: "Admin" });

    await ident.removeRole({ user: alice });

    const q = await ident._getRole({ user: alice });
    assertEquals(q[0].role, null);

    const hasRole = await ident._hasRole({ user: alice, role: "Admin" });
    assertEquals(hasRole[0].hasRole, false);

  } finally {
    await client.close();
  }
});

Deno.test("Identifying: Edge cases", async () => {
  const [db, client] = await testDb();
  const ident = new IdentifyingConcept(db);
  try {
    // Empty role
    const err = await ident.setRole({ user: alice, role: "" });
    assertEquals("error" in err, true);

    // Remove from user without role
    const err2 = await ident.removeRole({ user: "dummy" as User });
    assertEquals("error" in err2, true);

  } finally {
    await client.close();
  }
});
