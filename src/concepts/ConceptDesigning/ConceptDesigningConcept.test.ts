import "jsr:@std/dotenv/load";
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ConceptDesigningConcept from "./ConceptDesigningConcept.ts";

const project1 = "project:1" as ID;

Deno.test("Action: delete removes design", async () => {
  const [db, client] = await testDb();
  const designer = new ConceptDesigningConcept(db);

  try {
    // 1. Manually insert a design
    await designer.designs.insertOne({
      _id: project1,
      plan: {},
      libraryPulls: [],
      customConcepts: [],
      status: "complete",
      createdAt: new Date(),
    });

    // Verify it exists
    const query1 = await designer._getDesign({ project: project1 });
    assertEquals(query1.length, 1);
    assertEquals(query1[0].design._id, project1);

    // 2. Delete it
    const deleteResult = await designer.delete({ project: project1 });
    assertEquals("error" in deleteResult, false);

    // 3. Verify it is gone
    const query2 = await designer._getDesign({ project: project1 });
    assertEquals(query2.length, 0);

    // 4. Try deleting again (should fail)
    const deleteResult2 = await designer.delete({ project: project1 });
    assertEquals("error" in deleteResult2, true);
    if ("error" in deleteResult2) {
      assertEquals(deleteResult2.error, "Design does not exist");
    }

  } finally {
    await client.close();
  }
});
