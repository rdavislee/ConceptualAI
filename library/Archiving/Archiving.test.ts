import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ArchivingConcept, { Target } from "./ArchivingConcept.ts";

const target1 = "post:1" as Target;
const target2 = "post:2" as Target;

Deno.test({
  name: "Archiving: Basic lifecycle",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const archiving = new ArchivingConcept(db);
    try {
      // 1. Archive
      await archiving.archive({ target: target1 });

      // 2. Check
      const isArchived1 = await archiving._isArchived({ target: target1 });
      assertEquals(isArchived1[0].archived, true);

      const isArchived2 = await archiving._isArchived({ target: target2 });
      assertEquals(isArchived2[0].archived, false);

      // 3. All archived
      const all = await archiving._allArchived();
      assertEquals(all[0].targets.length, 1);
      assertEquals(all[0].targets.includes(target1), true);

      // 4. Unarchive
      await archiving.unarchive({ target: target1 });
      const isArchived3 = await archiving._isArchived({ target: target1 });
      assertEquals(isArchived3[0].archived, false);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Archiving: Edge Cases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const archiving = new ArchivingConcept(db);
    try {
      // Archive twice
      await archiving.archive({ target: target1 });
      const err1 = await archiving.archive({ target: target1 });
      assertEquals("error" in err1, true);

      // Unarchive non-existent
      const err2 = await archiving.unarchive({ target: target2 });
      assertEquals("error" in err2, true);

      // deleteByTarget removes archived record
      await archiving.archive({ target: target1 });
      await archiving.deleteByTarget({ target: target1 });
      const isArchivedAfter = await archiving._isArchived({ target: target1 });
      assertEquals(isArchivedAfter[0].archived, false);
    } finally {
      await client.close();
    }
  },
});
