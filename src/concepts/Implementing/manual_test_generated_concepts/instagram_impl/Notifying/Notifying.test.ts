import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import NotifyingConcept, { User } from "./NotifyingConcept.ts";

const alice = "user:Alice" as User;
const bob = "user:Bob" as User;

Deno.test("Principle: User receives, reads, and deletes a notification", async () => {
  const [db, client] = await testDb();
  const notifying = new NotifyingConcept(db);

  try {
    // 1. Notify Alice
    const notifyRes = await notifying.notify({
      recipient: alice,
      title: "Welcome",
      body: "Welcome to the platform!",
      deepLink: "/home",
    });

    assertEquals("notificationId" in notifyRes, true);
    const notificationId = (notifyRes as { notificationId: string }).notificationId;

    // 2. Check unread notifications
    const unread = await notifying._getUnread({ user: alice });
    assertEquals(unread.length, 1);
    assertEquals(unread[0].notification._id, notificationId);
    assertEquals(unread[0].notification.isRead, false);
    assertEquals(unread[0].notification.title, "Welcome");
    assertEquals(unread[0].notification.recipient, alice);

    // 3. Mark as read
    const readRes = await notifying.markAsRead({ notificationId, user: alice });
    assertEquals("error" in readRes, false);

    // 4. Verify state after reading
    const unreadAfter = await notifying._getUnread({ user: alice });
    assertEquals(unreadAfter.length, 0);

    const all = await notifying._getAll({ user: alice });
    assertEquals(all.length, 1);
    assertEquals(all[0].notification.isRead, true);

    // 5. Delete notification
    const deleteRes = await notifying.delete({ notificationId, user: alice });
    assertEquals("error" in deleteRes, false);

    // 6. Verify deletion
    const allAfter = await notifying._getAll({ user: alice });
    assertEquals(allAfter.length, 0);
  } finally {
    await client.close();
  }
});

Deno.test("Action: notify - Validation", async () => {
  const [db, client] = await testDb();
  const notifying = new NotifyingConcept(db);

  try {
    // Missing recipient
    // @ts-ignore: Testing runtime validation
    const res1 = await notifying.notify({ title: "T", body: "B" });
    assertEquals("error" in res1, true);

    // Missing title
    // @ts-ignore: Testing runtime validation
    const res2 = await notifying.notify({ recipient: alice, body: "B" });
    assertEquals("error" in res2, true);

    // Missing body
    // @ts-ignore: Testing runtime validation
    const res3 = await notifying.notify({ recipient: alice, title: "T" });
    assertEquals("error" in res3, true);
  } finally {
    await client.close();
  }
});

Deno.test("Action: markAsRead - Ownership and Existence", async () => {
  const [db, client] = await testDb();
  const notifying = new NotifyingConcept(db);

  try {
    const notifyRes = await notifying.notify({
      recipient: alice,
      title: "Hi",
      body: "Hello",
    });
    const notificationId = (notifyRes as { notificationId: string }).notificationId;

    // 1. Try to mark as read by wrong user (Bob)
    const resBob = await notifying.markAsRead({ notificationId, user: bob });
    assertEquals("error" in resBob, true);
    assertEquals((resBob as { error: string }).error, "Notification not found or does not belong to user");

    // Verify it is still unread for Alice
    const unread = await notifying._getUnread({ user: alice });
    assertEquals(unread.length, 1);

    // 2. Try to mark non-existent notification
    const resFake = await notifying.markAsRead({ notificationId: "fake-id", user: alice });
    assertEquals("error" in resFake, true);
  } finally {
    await client.close();
  }
});

Deno.test("Action: delete - Ownership and Existence", async () => {
  const [db, client] = await testDb();
  const notifying = new NotifyingConcept(db);

  try {
    const notifyRes = await notifying.notify({
      recipient: alice,
      title: "Hi",
      body: "Hello",
    });
    const notificationId = (notifyRes as { notificationId: string }).notificationId;

    // 1. Try to delete by wrong user (Bob)
    const resBob = await notifying.delete({ notificationId, user: bob });
    assertEquals("error" in resBob, true);

    // Verify it still exists
    const all = await notifying._getAll({ user: alice });
    assertEquals(all.length, 1);

    // 2. Try to delete non-existent notification
    const resFake = await notifying.delete({ notificationId: "fake-id", user: alice });
    assertEquals("error" in resFake, true);
  } finally {
    await client.close();
  }
});

Deno.test("Queries: Sorting and Filtering", async () => {
  const [db, client] = await testDb();
  const notifying = new NotifyingConcept(db);

  try {
    // Create 3 notifications with slight delays to ensure timestamp differences
    await notifying.notify({ recipient: alice, title: "1", body: "First" });
    await new Promise((r) => setTimeout(r, 10));
    await notifying.notify({ recipient: alice, title: "2", body: "Second" });
    await new Promise((r) => setTimeout(r, 10));
    const res3 = await notifying.notify({ recipient: alice, title: "3", body: "Third" });
    const id3 = (res3 as { notificationId: string }).notificationId;

    // Mark the latest one as read
    await notifying.markAsRead({ notificationId: id3, user: alice });

    // Test _getAll: Should return 3, sorted by createdAt desc (3, 2, 1)
    const all = await notifying._getAll({ user: alice });
    assertEquals(all.length, 3);
    assertEquals(all[0].notification.title, "3");
    assertEquals(all[1].notification.title, "2");
    assertEquals(all[2].notification.title, "1");

    // Test _getUnread: Should return 2 (1 and 2), sorted by createdAt desc (2, 1)
    const unread = await notifying._getUnread({ user: alice });
    assertEquals(unread.length, 2);
    assertEquals(unread[0].notification.title, "2");
    assertEquals(unread[1].notification.title, "1");
    assertEquals(unread[0].notification.isRead, false);
  } finally {
    await client.close();
  }
});