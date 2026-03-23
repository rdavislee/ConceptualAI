import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";
import { generateText } from "@utils/ai.ts";

export type User = ID;

const PREFIX = "AIConversation" + ".";

export interface Conversation {
  conversationId: ID;
  owner: User;
  systemPrompt?: string;
  status: string;
  messages: Array<{ role: string; content: string }>;
}

interface ConversationState {
  _id: ID;
  owner: User;
  systemPrompt?: string;
  status: string;
  messages: Array<{ role: string; content: string }>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept AIConversation
 * @purpose Conversational AI with persistent threads whose history grows with each exchange.
 */
export default class AIConversationConcept {
  readonly conversations: Collection<ConversationState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.conversations = this.db.collection<ConversationState>(PREFIX + "conversations");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.conversations.createIndex({ owner: 1, updatedAt: -1 });
    this.indexesCreated = true;
  }

  private toConversation(doc: ConversationState): Conversation {
    return {
      conversationId: doc._id,
      owner: doc.owner,
      systemPrompt: doc.systemPrompt,
      status: doc.status,
      messages: doc.messages,
    };
  }

  /**
   * createConversation (owner: User, systemPrompt?: String) : (conversationId: ID)
   */
  async createConversation(
    { owner, systemPrompt }: { owner: User; systemPrompt?: string },
  ): Promise<{ conversationId: string }> {
    const conversationId = freshID();
    const now = new Date();
    await this.conversations.insertOne({
      _id: conversationId,
      owner,
      systemPrompt,
      status: "idle",
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    return { conversationId };
  }

  /**
   * setSystemPrompt (conversationId: ID, systemPrompt: String) : (ok: Flag)
   */
  async setSystemPrompt(
    { conversationId, systemPrompt }: { conversationId: string; systemPrompt: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.conversations.updateOne(
      { _id: conversationId as ID },
      { $set: { systemPrompt, updatedAt: new Date() } },
    );
    if (res.matchedCount === 0) {
      return { error: "Conversation not found" };
    }
    return { ok: true };
  }

  /**
   * sendMessage (conversationId: ID, role: String, content: String, instructions?: String, context?: Object) : (reply?: String, error?: String)
   */
  async sendMessage(
    { conversationId, role, content, instructions, context }: {
      conversationId: string;
      role: string;
      content: string;
      instructions?: string;
      context?: Record<string, unknown>;
    },
  ): Promise<{ reply?: string; error?: string }> {
    const r = role?.trim() ?? "";
    const c = content?.trim() ?? "";
    if (!r || !c) {
      return { error: "Role and content must be non-empty" };
    }

    const conv = await this.conversations.findOne({ _id: conversationId as ID });
    if (!conv) {
      return { error: "Conversation not found" };
    }
    if (conv.status !== "idle") {
      return { error: "Conversation is not idle" };
    }

    const userMsg = { role: r, content: c };
    const messagesForAi = [...conv.messages, userMsg];

    const res = await this.conversations.updateOne(
      { _id: conversationId as ID, status: "idle" },
      {
        $set: { status: "thinking", updatedAt: new Date() },
        $push: { messages: userMsg },
      },
    );
    if (res.matchedCount === 0) {
      return { error: "Conversation not found or not idle" };
    }

    const systemPrompt = conv.systemPrompt ?? "";
    const parts: string[] = [];
    if (instructions?.trim()) parts.push(instructions.trim());
    if (context !== undefined && context !== null && typeof context === "object") {
      parts.push("Context: " + JSON.stringify(context));
    }
    const transcript = messagesForAi.map((m) => `${m.role}: ${m.content}`).join("\n");
    parts.push(
      "Reply with a brief assistant message only (plain text, no role prefix).\n\n" + transcript,
    );
    const userPrompt = parts.join("\n\n");

    try {
      const reply = await generateText(userPrompt, systemPrompt);
      const trimmed = reply?.trim() ?? "";
      if (!trimmed) {
        await this.conversations.updateOne(
          { _id: conversationId as ID },
          { $set: { status: "idle", updatedAt: new Date() } },
        );
        return { error: "Empty AI response" };
      }
      await this.conversations.updateOne(
        { _id: conversationId as ID },
        {
          $set: { status: "idle", updatedAt: new Date() },
          $push: { messages: { role: "assistant", content: trimmed } },
        },
      );
      return { reply: trimmed };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await this.conversations.updateOne(
        { _id: conversationId as ID },
        { $set: { status: "idle", updatedAt: new Date() } },
      );
      return { error: errMsg };
    }
  }

  /**
   * deleteConversation (conversationId: ID) : (ok: Flag)
   */
  async deleteConversation(
    { conversationId }: { conversationId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.conversations.deleteOne({ _id: conversationId as ID });
    if (res.deletedCount === 0) {
      return { error: "Conversation not found" };
    }
    return { ok: true };
  }

  /**
   * deleteAllConversationsForOwner (owner: User) : (ok: Flag)
   */
  async deleteAllConversationsForOwner(
    { owner }: { owner: User },
  ): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.conversations.deleteMany({ owner });
    return { ok: true };
  }

  /**
   * _getConversation (conversationId: ID) : (conversation: Conversation)
   */
  async _getConversation(
    { conversationId }: { conversationId: string },
  ): Promise<Array<{ conversation: Conversation }>> {
    const doc = await this.conversations.findOne({ _id: conversationId as ID });
    if (!doc) return [];
    return [{ conversation: this.toConversation(doc) }];
  }

  /**
   * _listConversationsForOwner (owner: User) : (conversationIds: set of ID)
   */
  async _listConversationsForOwner(
    { owner }: { owner: User },
  ): Promise<Array<{ conversationIds: ID[] }>> {
    await this.ensureIndexes();
    const docs = await this.conversations.find({ owner }, { projection: { _id: 1 } }).toArray();
    return [{ conversationIds: docs.map((d) => d._id) }];
  }
}
