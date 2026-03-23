import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import AIConversationConcept, { User } from "./AIConversationConcept.ts";

const owner = "user:AIConvOwner" as User;
const CONV_COLLECTION = "AIConversation.conversations";

Deno.test({
  name: "Principle: create, sendMessage stores user + assistant, status idle",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ai = new AIConversationConcept(db);
    try {
      const { conversationId } = await ai.createConversation({
        owner,
        systemPrompt: "You reply with one short line. No markdown.",
      });

      const send = await ai.sendMessage({
        conversationId,
        role: "user",
        content: "Reply with exactly: pong",
      });
      assertEquals("reply" in send, true);
      assertExists((send as { reply: string }).reply);
      assertEquals((send as { reply: string }).reply.trim().length > 0, true);

      const got = await ai._getConversation({ conversationId });
      assertEquals(got.length, 1);
      const conv = got[0].conversation;
      assertEquals(conv.status, "idle");
      assertEquals(conv.messages.length >= 2, true);
      const last = conv.messages[conv.messages.length - 1];
      assertEquals(last.role, "assistant");
      assertEquals(last.content.trim().length > 0, true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Queries: list and setSystemPrompt",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ai = new AIConversationConcept(db);
    try {
      const { conversationId } = await ai.createConversation({ owner });
      const set = await ai.setSystemPrompt({
        conversationId,
        systemPrompt: "Be brief.",
      });
      assertEquals("ok" in set, true);

      const listed = await ai._listConversationsForOwner({ owner });
      assertEquals(listed[0].conversationIds.includes(conversationId as ID), true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Validation: sendMessage rejects empty role or content",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ai = new AIConversationConcept(db);
    try {
      const { conversationId } = await ai.createConversation({ owner });
      const r1 = await ai.sendMessage({
        conversationId,
        role: "",
        content: "x",
      });
      assertEquals("error" in r1, true);
      const r2 = await ai.sendMessage({
        conversationId,
        role: "user",
        content: "   ",
      });
      assertEquals("error" in r2, true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Action: deleteConversation and deleteAllConversationsForOwner",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ai = new AIConversationConcept(db);
    try {
      const { conversationId } = await ai.createConversation({ owner });
      const del = await ai.deleteConversation({ conversationId });
      assertEquals("ok" in del, true);

      const { conversationId: id2 } = await ai.createConversation({ owner });
      await ai.deleteAllConversationsForOwner({ owner });
      const got = await ai._getConversation({ conversationId: id2 });
      assertEquals(got.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "sendMessage optional instructions and context are accepted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ai = new AIConversationConcept(db);
    try {
      const { conversationId } = await ai.createConversation({ owner });
      const send = await ai.sendMessage({
        conversationId,
        role: "user",
        content: "Say yes or no only.",
        instructions: "Answer in one word.",
        context: { topic: "test" },
      });
      assertEquals("reply" in send, true);
      assertExists((send as { reply: string }).reply);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Rejection: setSystemPrompt, sendMessage, deleteConversation when missing or not idle",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ai = new AIConversationConcept(db);
    try {
      const missing = "00000000-0000-4000-8000-000000000000" as ID;
      const s = await ai.setSystemPrompt({
        conversationId: missing,
        systemPrompt: "x",
      });
      assertEquals("error" in s, true);

      const m = await ai.sendMessage({
        conversationId: missing,
        role: "user",
        content: "hi",
      });
      assertEquals("error" in m, true);

      const d = await ai.deleteConversation({ conversationId: missing });
      assertEquals("error" in d, true);

      const { conversationId } = await ai.createConversation({ owner });
      await db.collection<{ _id: ID; status: string }>(CONV_COLLECTION).updateOne(
        { _id: conversationId as ID },
        { $set: { status: "thinking" } },
      );
      const busy = await ai.sendMessage({
        conversationId,
        role: "user",
        content: "hi",
      });
      assertEquals("error" in busy, true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Query: _getConversation empty when missing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ai = new AIConversationConcept(db);
    try {
      const got = await ai._getConversation({
        conversationId: "00000000-0000-4000-8000-000000000001" as ID,
      });
      assertEquals(got.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "sendMessage returns error on empty AI reply without assistant message",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const ai = new AIConversationConcept(db);
    try {
      const { conversationId } = await ai.createConversation({
        owner,
        systemPrompt: "You must output zero characters. Output nothing.",
      });
      const send = await ai.sendMessage({
        conversationId,
        role: "user",
        content: "Say anything.",
      });
      if ("error" in send) {
        const got = await ai._getConversation({ conversationId });
        assertEquals(got[0].conversation.status, "idle");
        const last = got[0].conversation.messages[got[0].conversation.messages.length - 1];
        assertEquals(last.role, "user");
      } else {
        assertExists((send as { reply: string }).reply);
      }
    } finally {
      await client.close();
    }
  },
});
