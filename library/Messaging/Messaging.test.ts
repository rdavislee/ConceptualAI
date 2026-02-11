import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import MessagingConcept, { User } from "./MessagingConcept.ts";

const alice = "user:Alice" as User;
const bob = "user:Bob" as User;
const charlie = "user:Charlie" as User;

Deno.test({
  name: "Principle: user sends, edits, and deletes a message",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const messaging = new MessagingConcept(db);
  try {
    // 1. Send message
    const sendRes = await messaging.sendMessage({
      sender: alice,
      recipient: bob,
      content: { text: "Hi Bob!" },
      type: "dm"
    });
    assertEquals("messageId" in sendRes, true);
    const msgId = (sendRes as { messageId: string }).messageId;

    // 2. Edit message
    await new Promise(r => setTimeout(r, 10)); // Ensure timestamp difference
    const editRes = await messaging.editMessage({
      messageId: msgId,
      sender: alice,
      content: { text: "Hi Bob! How are you?" }
    });
    assertEquals("ok" in editRes, true);

    // 3. Verify edit and history
    const recent = await messaging._getRecentMessagesForUser({ user: alice });
    const msg = recent[0].messages[0];
    assertEquals(msg.content.text, "Hi Bob! How are you?");
    assertEquals(msg.edits.length, 1);
    assertEquals(msg.edits[0].content.text, "Hi Bob!");
    assertNotEquals(msg.updatedAt, msg.createdAt);

    // 4. Delete message
    const delRes = await messaging.deleteMessage({ messageId: msgId, sender: alice });
    assertEquals("ok" in delRes, true);

    // 5. Verify deletion
    const finalBetween = await messaging._getMessagesBetween({ userA: alice, userB: bob });
    assertEquals(finalBetween[0].messages.length, 0);
  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Action: sendMessage - Validation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const messaging = new MessagingConcept(db);
  try {
    const res = await messaging.sendMessage({ sender: alice, recipient: bob, content: {} });
    assertEquals("error" in res, true, "Should fail on empty content");
  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Action: editMessage - Auth and Existence",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const messaging = new MessagingConcept(db);
  try {
    const sendRes = await messaging.sendMessage({ sender: alice, recipient: bob, content: { text: "X" } });
    const msgId = (sendRes as { messageId: string }).messageId;

    // Wrong sender
    const res1 = await messaging.editMessage({ messageId: msgId, sender: bob, content: { text: "Y" } });
    assertEquals("error" in res1, true);

    // Non-existent message
    const res2 = await messaging.editMessage({ messageId: "nonexistent-message-id", sender: alice, content: { text: "Y" } });
    assertEquals("error" in res2, true);

    // Empty content
    const res3 = await messaging.editMessage({ messageId: msgId, sender: alice, content: {} });
    assertEquals("error" in res3, true);
  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Queries: Conversation Partner Tracking",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const messaging = new MessagingConcept(db);
  try {
    await messaging.sendMessage({ sender: alice, recipient: bob, content: { t: 1 } });
    await messaging.sendMessage({ sender: charlie, recipient: alice, content: { t: 2 } });

    const partners = await messaging._getConversationPartners({ user: alice });
    assertEquals(partners[0].partners.length, 2);
    assertEquals(partners[0].partners.includes(bob), true);
    assertEquals(partners[0].partners.includes(charlie), true);
  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Lifecycle: deleteBySender removes all messages by sender",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const messaging = new MessagingConcept(db);
    try {
      await messaging.sendMessage({ sender: alice, recipient: bob, content: { t: 1 } });
      await messaging.sendMessage({ sender: alice, recipient: charlie, content: { t: 2 } });
      await messaging.sendMessage({ sender: bob, recipient: alice, content: { t: 3 } });

      const res = await messaging.deleteBySender({ sender: alice });
      assertEquals("ok" in res, true);

      const aliceRecent = await messaging._getRecentMessagesForUser({ user: alice });
      assertEquals(aliceRecent[0].messages.length, 1);
      assertEquals(aliceRecent[0].messages[0].content.t, 3);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Lifecycle: deleteByRecipient removes all messages to recipient",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const messaging = new MessagingConcept(db);
    try {
      await messaging.sendMessage({ sender: alice, recipient: bob, content: { t: 1 } });
      await messaging.sendMessage({ sender: charlie, recipient: bob, content: { t: 2 } });

      const res = await messaging.deleteByRecipient({ recipient: bob });
      assertEquals("ok" in res, true);

      const bobRecv = await messaging._getMessagesForRecipient({ recipient: bob });
      assertEquals(bobRecv[0].messages.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Queries: Message Filtering and Sorting",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const messaging = new MessagingConcept(db);
  try {
    await messaging.sendMessage({ sender: alice, recipient: bob, content: { order: 1 } });
    await new Promise(r => setTimeout(r, 10));
    await messaging.sendMessage({ sender: bob, recipient: alice, content: { order: 2 } });

    // Between (oldest first for dialogue)
    const between = await messaging._getMessagesBetween({ userA: alice, userB: bob });
    assertEquals(between[0].messages[0].content.order, 1);
    assertEquals(between[0].messages[1].content.order, 2);

    // Recent (newest first for inbox style)
    const recent = await messaging._getRecentMessagesForUser({ user: alice });
    assertEquals(recent[0].messages[0].content.order, 2);
  } finally {
    await client.close();
  }
  },
});
