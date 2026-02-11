import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import JoiningConcept, { Member, Target } from "./JoiningConcept.ts";

const member1 = "user:1" as Member;
const member2 = "user:2" as Member;
const group1 = "group:1" as Target;
const group2 = "group:2" as Target;

Deno.test("Joining: Basic membership lifecycle", async () => {
  const [db, client] = await testDb();
  const joining = new JoiningConcept(db);
  try {
    // 1. Join
    await joining.join({ member: member1, target: group1 });
    await joining.join({ member: member2, target: group1 });
    await joining.join({ member: member1, target: group2 });

    // 2. Verify members
    const members1 = await joining._getMembers({ target: group1 });
    assertEquals(members1[0].members.length, 2);
    assertEquals(members1[0].members.includes(member1), true);
    assertEquals(members1[0].members.includes(member2), true);

    // 3. Verify memberships
    const memberships1 = await joining._getMemberships({ member: member1 });
    assertEquals(memberships1[0].targets.length, 2);
    assertEquals(memberships1[0].targets.includes(group1), true);
    assertEquals(memberships1[0].targets.includes(group2), true);

    // 4. Verify isMember
    const isMember1 = await joining._isMember({ member: member1, target: group1 });
    assertEquals(isMember1[0].member, true);

    // 5. Leave
    await joining.leave({ member: member1, target: group1 });
    const isMember2 = await joining._isMember({ member: member1, target: group1 });
    assertEquals(isMember2[0].member, false);

    const members2 = await joining._getMembers({ target: group1 });
    assertEquals(members2[0].members.length, 1);
    assertEquals(members2[0].members.includes(member2), true);

  } finally {
    await client.close();
  }
});

Deno.test("Joining: Edge Cases", async () => {
  const [db, client] = await testDb();
  const joining = new JoiningConcept(db);
  try {
    // Join twice
    await joining.join({ member: member1, target: group1 });
    const err1 = await joining.join({ member: member1, target: group1 });
    assertEquals("error" in err1, true);

    // Leave without joining
    const err2 = await joining.leave({ member: member2, target: group2 });
    assertEquals("error" in err2, true);

    // Query non-existent
    const members = await joining._getMembers({ target: "group:none" as Target });
    assertEquals(members[0].members.length, 0);

  } finally {
    await client.close();
  }
});

Deno.test("Joining: deleteByMember removes all memberships for member", async () => {
  const [db, client] = await testDb();
  const joining = new JoiningConcept(db);
  try {
    await joining.join({ member: member1, target: group1 });
    await joining.join({ member: member1, target: group2 });
    const before = await joining._getMemberships({ member: member1 });
    assertEquals(before[0].targets.length, 2);

    await joining.deleteByMember({ member: member1 });

    const after = await joining._getMemberships({ member: member1 });
    assertEquals(after[0].targets.length, 0);
    const members1 = await joining._getMembers({ target: group1 });
    assertEquals(members1[0].members.includes(member1), false);
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Joining: deleteByTarget removes all memberships for target",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const joining = new JoiningConcept(db);
    try {
      await joining.join({ member: member1, target: group1 });
      await joining.join({ member: member2, target: group1 });
      const before = await joining._getMembers({ target: group1 });
      assertEquals(before[0].members.length, 2);

      await joining.deleteByTarget({ target: group1 });

      const after = await joining._getMembers({ target: group1 });
      assertEquals(after[0].members.length, 0);
      const memberships1 = await joining._getMemberships({ member: member1 });
      assertEquals(memberships1[0].targets.includes(group1), false);
    } finally {
      await client.close();
    }
  },
});
