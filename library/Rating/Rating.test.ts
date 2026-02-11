import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import RatingConcept, { Subject, Target } from "./RatingConcept.ts";

const sub1 = "user:1" as Subject;
const sub2 = "user:2" as Subject;
const target1 = "item:1" as Target;

Deno.test("Rating: Basic lifecycle and aggregation", async () => {
  const [db, client] = await testDb();
  const rating = new RatingConcept(db);
  try {
    // 1. Rate
    await rating.rate({ subject: sub1, target: target1, score: 5 });
    await rating.rate({ subject: sub2, target: target1, score: 3 });

    // 2. Verify individual ratings
    const res1 = await rating._getUserRating({ subject: sub1, target: target1 });
    assertEquals(res1[0].score, 5);

    const res2 = await rating._getUserRating({ subject: sub2, target: target1 });
    assertEquals(res2[0].score, 3);

    // 3. Verify average
    const avg1 = await rating._getAverageRating({ target: target1 });
    assertEquals(avg1[0].average, 4);
    assertEquals(avg1[0].count, 2);

    // 4. Update rating
    await rating.rate({ subject: sub2, target: target1, score: 5 });
    const avg2 = await rating._getAverageRating({ target: target1 });
    assertEquals(avg2[0].average, 5);
    assertEquals(avg2[0].count, 2);

    // 5. Remove rating
    await rating.removeRating({ subject: sub1, target: target1 });
    const avg3 = await rating._getAverageRating({ target: target1 });
    assertEquals(avg3[0].average, 5);
    assertEquals(avg3[0].count, 1);

    const res3 = await rating._getUserRating({ subject: sub1, target: target1 });
    assertEquals(res3[0].score, null);

  } finally {
    await client.close();
  }
});

Deno.test("Rating: Edge Cases", async () => {
  const [db, client] = await testDb();
  const rating = new RatingConcept(db);
  try {
    // Invalid score
    const err = await rating.rate({ subject: sub1, target: target1, score: NaN });
    assertEquals("error" in err, true);

    // Score out of bounds
    const errBounds = await rating.rate({ subject: sub1, target: target1, score: 0 });
    assertEquals("error" in errBounds, true);
    const errBounds2 = await rating.rate({ subject: sub1, target: target1, score: 10 });
    assertEquals("error" in errBounds2, true);

    // Remove non-existent
    const err2 = await rating.removeRating({ subject: sub2, target: target1 });
    assertEquals("error" in err2, true);

    // Query average for non-existent item
    const avg = await rating._getAverageRating({ target: "item:none" as Target });
    assertEquals(avg[0].average, 0);
    assertEquals(avg[0].count, 0);

  } finally {
    await client.close();
  }
});
