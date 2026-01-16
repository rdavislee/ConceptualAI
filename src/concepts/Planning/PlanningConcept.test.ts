import "jsr:@std/dotenv/load";
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import PlanningConcept from "./PlanningConcept.ts";

const project1 = "project:1" as ID;

Deno.test("Action: delete removes plan", async () => {
  const [db, client] = await testDb();
  const planner = new PlanningConcept(db);

  try {
    // 1. Manually insert a plan (skipping initiate which requires python agent)
    await planner.plans.insertOne({
      _id: project1,
      description: "Test plan",
      status: "complete",
      plan: {},
      questions: [],
      clarifications: [],
      createdAt: new Date(),
    });

    // Verify it exists
    const query1 = await planner._getPlan({ project: project1 });
    assertEquals(query1.length, 1);
    assertEquals(query1[0].plan._id, project1);

    // 2. Delete it
    const deleteResult = await planner.delete({ project: project1 });
    assertEquals("error" in deleteResult, false);

    // 3. Verify it is gone
    const query2 = await planner._getPlan({ project: project1 });
    assertEquals(query2.length, 0);

    // 4. Try deleting again (should fail)
    const deleteResult2 = await planner.delete({ project: project1 });
    assertEquals("error" in deleteResult2, true);
    if ("error" in deleteResult2) {
      assertEquals(deleteResult2.error, "Plan does not exist");
    }

  } finally {
    await client.close();
  }
});
