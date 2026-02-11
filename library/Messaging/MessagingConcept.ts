import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
// Messaging [User, Message]
export type User = ID;
export type Message = ID;

const PREFIX = "Messaging" + ".";

// State: a set of Messages with a message ID, a sender ID...
interface MessageState {
  _id: ID; // message ID
  sender: User;
  recipient: User;
  content: Record<string, unknown>;
  type?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  edits: Array<{ content: Record<string, unknown>; timestamp: Date }>;
}

/**
 * @concept Messaging
 * @purpose Allows users to send messages to other users or groups, supporting various formats and metadata.
 * @principle A message is sent from a sender to one or more recipients; once sent, messages can be retrieved by their participants and potentially deleted by the sender.
 * @state
 *  a set of Messages with a message ID, a sender ID (User), a recipient ID (User or Group), a content Object, a type? String, a metadata? Object, a createdAt DateTime, an updatedAt DateTime, an edits List of Objects
 */
export default class MessagingConcept {
  messages: Collection<MessageState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.messages = this.db.collection<MessageState>(PREFIX + "messages");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.messages.createIndex({ sender: 1, recipient: 1, createdAt: 1 }),
      this.messages.createIndex({ recipient: 1, createdAt: -1 }),
      this.messages.createIndex({ sender: 1, createdAt: -1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: sendMessage (sender: UserID, recipient: UserID, content: Object, type?: String, metadata?: Object) : (message: messageID)
   * requires: content is not empty
   * effects: create message with createdAt := now, updatedAt := now, edits := []
   */
  async sendMessage(
    { sender, recipient, content, type, metadata }: {
      sender: User;
      recipient: User;
      content: Record<string, unknown>;
      type?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ messageId: string } | { error: string }> {
    // Validate content: must be a non-null object with at least one defined value
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return { error: "Message content cannot be empty" };
    }
    const hasValue = Object.values(content).some((v) => v !== undefined);
    if (!hasValue) {
      return { error: "Message content cannot be empty" };
    }

    const now = new Date();
    const messageId = freshID();
    await this.messages.insertOne({
      _id: messageId,
      sender,
      recipient,
      content,
      type,
      metadata,
      createdAt: now,
      updatedAt: now,
      edits: [],
    });

    return { messageId };
  }

  /**
   * Action: editMessage (message: messageID, sender: UserID, content: Object) : (ok: Flag)
   * requires: message exists, sender of message is senderID, content is not empty
   * effects: add current content to edits list, update content to new content, set updatedAt := now
   */
  async editMessage(
    { messageId, sender, content }: { messageId: string; sender: User; content: Record<string, unknown> },
  ): Promise<{ ok: boolean } | { error: string }> {
    // Validate content: must be a non-null object with at least one defined value
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return { error: "Message content cannot be empty" };
    }
    const hasValue = Object.values(content).some((v) => v !== undefined);
    if (!hasValue) {
      return { error: "Message content cannot be empty" };
    }

    const message = await this.messages.findOne({ _id: messageId as ID, sender });
    if (!message) {
      return { error: "Message not found or sender mismatch" };
    }

    const now = new Date();
    const editEntry = { content: message.content, timestamp: message.updatedAt };

    const res = await this.messages.updateOne(
      { _id: messageId as ID, sender },
      {
        $set: { content, updatedAt: now },
        $push: { edits: editEntry },
      },
    );

    if (res.matchedCount === 0) {
      return { error: "Failed to update message" };
    }

    return { ok: true };
  }

  /**
   * Action: deleteMessage (message: messageID, sender: UserID) : (ok: Flag)
   * requires: message exists, sender of message is senderID
   * effects: delete the message
   */
  async deleteMessage(
    { messageId, sender }: { messageId: string; sender: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.messages.deleteOne({ _id: messageId as ID, sender });

    if (res.deletedCount === 0) {
      return { error: "Message not found or sender mismatch" };
    }

    return { ok: true };
  }

  /**
   * Delete lifecycle: remove all messages sent by a user (for account deletion).
   */
  async deleteBySender({ sender }: { sender: User }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.messages.deleteMany({ sender });
    return { ok: true };
  }

  /**
   * Delete lifecycle: remove all messages received by a user (for account deletion).
   */
  async deleteByRecipient({ recipient }: { recipient: User }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.messages.deleteMany({ recipient });
    return { ok: true };
  }

  /**
   * Query: _getMessagesBetween(userA: UserID, userB: UserID) : (messages: Set<Message>)
   * Retrieves messages exchanged between two specific users (either direction)
   * Optional limit/skip for pagination.
   */
  async _getMessagesBetween(
    { userA, userB, limit, skip }: { userA: User; userB: User; limit?: number; skip?: number },
  ): Promise<Array<{ messages: MessageState[] }>> {
    await this.ensureIndexes();
    let cursor = this.messages.find({
      $or: [
        { sender: userA, recipient: userB },
        { sender: userB, recipient: userA },
      ],
    }).sort({ createdAt: 1 });
    if (skip != null) cursor = cursor.skip(skip);
    if (limit != null) cursor = cursor.limit(limit);
    const messages = await cursor.toArray();
    return [{ messages }];
  }

  /**
   * Query: _getRecentMessagesForUser(user: UserID) : (messages: Set<Message>)
   * Retrieves all messages where the user is either sender or recipient
   * Optional limit/skip for pagination.
   */
  async _getRecentMessagesForUser(
    { user, limit, skip }: { user: User; limit?: number; skip?: number },
  ): Promise<Array<{ messages: MessageState[] }>> {
    await this.ensureIndexes();
    let cursor = this.messages.find({
      $or: [
        { sender: user },
        { recipient: user },
      ],
    }).sort({ createdAt: -1 });
    if (skip != null) cursor = cursor.skip(skip);
    if (limit != null) cursor = cursor.limit(limit);
    const messages = await cursor.toArray();
    return [{ messages }];
  }

  /**
   * Query: _getMessagesForRecipient(recipient: UserID) : (messages: Set<Message>)
   * Useful for group messages or specifically checking inbox
   * Optional limit/skip for pagination.
   */
  async _getMessagesForRecipient(
    { recipient, limit, skip }: { recipient: User; limit?: number; skip?: number },
  ): Promise<Array<{ messages: MessageState[] }>> {
    await this.ensureIndexes();
    let cursor = this.messages.find({ recipient }).sort({ createdAt: -1 });
    if (skip != null) cursor = cursor.skip(skip);
    if (limit != null) cursor = cursor.limit(limit);
    const messages = await cursor.toArray();
    return [{ messages }];
  }

  /**
   * Query: _getConversationPartners(user: UserID) : (partners: Set<UserID>)
   * Finds all distinct users this user has messaged or received messages from
   */
  async _getConversationPartners(
    { user }: { user: User },
  ): Promise<Array<{ partners: User[] }>> {
    await this.ensureIndexes();
    const senders = await this.messages.distinct("sender", { recipient: user });
    const recipients = await this.messages.distinct("recipient", { sender: user });
    const partners = [...new Set([...senders, ...recipients])] as User[];
    return [{ partners }];
  }
}
