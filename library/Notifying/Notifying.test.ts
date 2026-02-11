import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import NotifyingConcept, { User, Item } from "./NotifyingConcept.ts";

const userA = "user:Alice" as User;
const userB = "user:Bob" as User;
const trigger1 = "post:1" as Item;
const trigger2 = "post:2" as Item;

Deno.test({
  name: "Principle: notification lifecycle and redundant transitions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const notifying = new NotifyingConcept(db);
  try {
    // 1. Create
    const res = await notifying.notify({
      recipient: userA,
      trigger: trigger1,
      content: { message: "T1" },
      type: "alert",
      metadata: { priority: "high" }
    });
    const nid = (res as { notificationId: string }).notificationId;

    // 2. Initial state
    let list = await notifying._getNotificationsForUser({ user: userA });
    let notif = list[0].notifications[0];
    assertEquals(notif.status, "unseen");
    assertEquals(notif.type, "alert");
    assertEquals(notif.metadata?.priority, "high");

    // 3. Mark as seen (First time)
    await notifying.markAsSeen({ notificationId: nid, recipient: userA });
    list = await notifying._getNotificationsForUser({ user: userA });
    notif = list[0].notifications[0];
    const firstSeenAt = notif.seenAt;
    assertNotEquals(firstSeenAt, undefined);
    assertEquals(notif.status, "seen");

    // 4. Mark as seen (Second time - should be idempotent and NOT change seenAt)
    await new Promise(r => setTimeout(r, 10));
    await notifying.markAsSeen({ notificationId: nid, recipient: userA });
    list = await notifying._getNotificationsForUser({ user: userA });
    assertEquals(list[0].notifications[0].seenAt?.getTime(), firstSeenAt?.getTime(), "seenAt should be preserved");

    // 5. Mark as read (First time)
    await notifying.markAsRead({ notificationId: nid, recipient: userA });
    list = await notifying._getNotificationsForUser({ user: userA });
    notif = list[0].notifications[0];
    const firstReadAt = notif.readAt;
    assertNotEquals(firstReadAt, undefined);
    assertEquals(notif.status, "read");

    // 6. Mark as read (Second time - idempotent)
    await new Promise(r => setTimeout(r, 10));
    await notifying.markAsRead({ notificationId: nid, recipient: userA });
    list = await notifying._getNotificationsForUser({ user: userA });
    assertEquals(list[0].notifications[0].readAt?.getTime(), firstReadAt?.getTime(), "readAt should be preserved");

    // 7. Directly mark unseen as read
    const res2 = await notifying.notify({ recipient: userA, trigger: trigger2, content: { m: "T2" } });
    const nid2 = (res2 as { notificationId: string }).notificationId;
    await notifying.markAsRead({ notificationId: nid2, recipient: userA });
    list = await notifying._getNotificationsForUser({ user: userA });
    const n2 = list[0].notifications.find(n => n.content.m === "T2");
    assertEquals(n2?.status, "read");
    assertNotEquals(n2?.seenAt, undefined, "seenAt should be set even if marked as read directly");

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Action: Edge Cases and Errors",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const notifying = new NotifyingConcept(db);
  try {
    const res = await notifying.notify({ recipient: userA, trigger: trigger1, content: { x: 1 } });
    const nid = (res as { notificationId: string }).notificationId;

    // 1. Invalid ID formats
    const err1 = await notifying.markAsSeen({ notificationId: "not-an-id", recipient: userA });
    assertEquals("error" in err1, true);

    const err2 = await notifying.deleteNotification({ notificationId: "!!!", recipient: userA });
    assertEquals("error" in err2, true);

    // 2. Non-existent IDs (valid format)
    const ghostId = "000000000000000000000000";
    const err3 = await notifying.markAsRead({ notificationId: ghostId, recipient: userA });
    assertEquals("error" in err3, true);

    // 3. Security (Bob trying to touch Alice's notifs)
    const err4 = await notifying.markAsSeen({ notificationId: nid, recipient: userB });
    assertEquals("error" in err4, true);

    const err5 = await notifying.deleteNotification({ notificationId: nid, recipient: userB });
    assertEquals("error" in err5, true);

    // 4. Empty content
    const err6 = await notifying.notify({ recipient: userA, trigger: trigger1, content: {} });
    assertEquals("error" in err6, true);

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Lifecycle: deleteByRecipient removes all notifications for user",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const notifying = new NotifyingConcept(db);
    try {
      await notifying.notify({ recipient: userA, trigger: trigger1, content: { x: 1 } });
      await notifying.notify({ recipient: userA, trigger: trigger2, content: { x: 2 } });
      await notifying.notify({ recipient: userB, trigger: trigger1, content: { x: 3 } });

      const res = await notifying.deleteByRecipient({ recipient: userA });
      assertEquals("ok" in res, true);

      const aliceNotifs = await notifying._getNotificationsForUser({ user: userA });
      assertEquals(aliceNotifs[0].notifications.length, 0);

      const bobNotifs = await notifying._getNotificationsForUser({ user: userB });
      assertEquals(bobNotifs[0].notifications.length, 1);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Lifecycle: deleteByTrigger removes all notifications for item",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const notifying = new NotifyingConcept(db);
    try {
      await notifying.notify({ recipient: userA, trigger: trigger1, content: { x: 1 } });
      await notifying.notify({ recipient: userB, trigger: trigger1, content: { x: 2 } });
      await notifying.notify({ recipient: userA, trigger: trigger2, content: { x: 3 } });

      const res = await notifying.deleteByTrigger({ trigger: trigger1 });
      assertEquals("ok" in res, true);

      const aliceNotifs = await notifying._getNotificationsForUser({ user: userA });
      assertEquals(aliceNotifs[0].notifications.length, 1);
      assertEquals(aliceNotifs[0].notifications[0].content.x, 3);

      const bobNotifs = await notifying._getNotificationsForUser({ user: userB });
      assertEquals(bobNotifs[0].notifications.length, 0);
  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Queries: Comprehensive Filtering and Sorting",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const notifying = new NotifyingConcept(db);
  try {
    // 1. Zero state
    const empty = await notifying._getNotificationsForUser({ user: userB });
    assertEquals(empty[0].notifications.length, 0);
    const countZero = await notifying._getUnreadCount({ user: userB });
    assertEquals(countZero[0].count, 0);

    // 2. Sorting (Latest First)
    await notifying.notify({ recipient: userA, trigger: trigger1, content: { seq: 1 } });
    await new Promise(r => setTimeout(r, 10));
    await notifying.notify({ recipient: userA, trigger: trigger1, content: { seq: 2 } });
    await new Promise(r => setTimeout(r, 10));
    await notifying.notify({ recipient: userA, trigger: trigger1, content: { seq: 3 } });

    const all = await notifying._getNotificationsForUser({ user: userA });
    assertEquals(all[0].notifications[0].content.seq, 3);
    assertEquals(all[0].notifications[2].content.seq, 1);

    // 3. Status Filtering & Counts
    const nid1 = all[0].notifications.find(n => n.content.seq === 1)!._id.toHexString();
    const nid3 = all[0].notifications.find(n => n.content.seq === 3)!._id.toHexString();

    await notifying.markAsSeen({ notificationId: nid3, recipient: userA }); // seq 3 is now seen
    await notifying.markAsRead({ notificationId: nid1, recipient: userA }); // seq 1 is now read

    // Unseen: seq 2
    const unseen = await notifying._getNotificationsForUser({ user: userA, status: "unseen" });
    assertEquals(unseen[0].notifications.length, 1);
    assertEquals(unseen[0].notifications[0].content.seq, 2);

    // Seen: seq 3
    const seen = await notifying._getNotificationsForUser({ user: userA, status: "seen" });
    assertEquals(seen[0].notifications.length, 1);
    assertEquals(seen[0].notifications[0].content.seq, 3);

    // Read: seq 1
    const read = await notifying._getNotificationsForUser({ user: userA, status: "read" });
    assertEquals(read[0].notifications.length, 1);
    assertEquals(read[0].notifications[0].content.seq, 1);

    // Unread count (unseen + seen): seq 2 + seq 3 = 2
    const counts = await notifying._getUnreadCount({ user: userA });
    assertEquals(counts[0].count, 2);

    // 4. System-wide query
    const sysAll = await notifying._allNotifications();
    assertEquals(sysAll[0].notifications.length, 3);

  } finally {
    await client.close();
  }
  },
});
