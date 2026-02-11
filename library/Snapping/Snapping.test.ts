import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import SnappingConcept, { User } from "./SnappingConcept.ts";

const userA = "user:A" as User;
const userB = "user:B" as User;
const userC = "user:C" as User;

Deno.test("Snapping: Basic lifecycle", async () => {
  const [db, client] = await testDb();
  const snapping = new SnappingConcept(db);
  try {
    // 1. Send snap A -> B
    const sendRes = await snapping.send({
      sender: userA,
      recipient: userB,
      media: { url: "photo.jpg" },
    });
    if ("error" in sendRes) throw new Error(sendRes.error);
    const snapId = sendRes.snap;

    // 2. Verify sent status
    const sentSnaps = await snapping._getSentSnaps({ user: userA });
    assertEquals(sentSnaps[0].snaps.length, 1);
    assertEquals(sentSnaps[0].snaps[0].status, "sent");

    // 3. Mark delivered
    await snapping.markDelivered({ snap: snapId });

    // 4. Verify recipient sees it
    const inbox = await snapping._getSnapsForUser({ user: userB });
    assertEquals(inbox[0].snaps.length, 1);
    assertEquals(inbox[0].snaps[0].status, "delivered");

    // 5. Open snap
    await snapping.open({ snap: snapId, recipient: userB });

    // 6. Verify opened status (not in inbox anymore because _getSnapsForUser excludes opened)
    const inboxAfter = await snapping._getSnapsForUser({ user: userB });
    assertEquals(inboxAfter[0].snaps.length, 0);

    // 7. Check full history
    const history = await snapping._getSnapsBetweenUsers({ userA: userA, userB: userB });
    assertEquals(history[0].snaps.length, 1);
    assertEquals(history[0].snaps[0].status, "opened");

    // 8. Delete
    await snapping.delete({ snap: snapId });
    const historyAfter = await snapping._getSnapsBetweenUsers({ userA: userA, userB: userB });
    assertEquals(historyAfter[0].snaps.length, 0);

  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Snapping: Edge Cases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const snapping = new SnappingConcept(db);
    try {
      const sendRes = await snapping.send({
        sender: userA,
        recipient: userB,
        media: { text: "hi" },
      });
      if ("error" in sendRes) throw new Error(sendRes.error);
      const snapId = sendRes.snap;

      // Wrong recipient tries to open
      const err1 = await snapping.open({ snap: snapId, recipient: userC });
      assertEquals("error" in err1, true);

      // Self snap
      const err2 = await snapping.send({
        sender: userA,
        recipient: userA,
        media: {},
      });
      assertEquals("error" in err2, true);

      // Mark delivered twice (should fail or return error depending on impl, here we check if status remains delivered)
      await snapping.markDelivered({ snap: snapId });
      // Second call might fail or be no-op, checking implementation: returns error if matchedCount is 0
      const err3 = await snapping.markDelivered({ snap: snapId });
      assertEquals("error" in err3, true);
    } finally {
      await client.close();
    }
  },
});
