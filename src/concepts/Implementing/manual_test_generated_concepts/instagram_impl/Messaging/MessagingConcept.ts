import { Collection, Db, ObjectId } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Messaging [User, Message]
export type User = ID;
export type Message = ID;

const PREFIX = "Messaging" + ".";

// State: a set of Messages with a message ID, a sender ID...
interface MessageState {
  _id: ObjectId; // message ID
  sender: User;
  recipient: User;
  content: Record<string, any>;
  type?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  edits: Array<{ content: Record<string, any>; timestamp: Date }>;
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

  constructor(private readonly db: Db) {
    this.messages = this.db.collection<MessageState>(PREFIX + "messages");
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
      content: Record<string, any>;
      type?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<{ messageId: string } | { error: string }> {
    if (!content || typeof content !== "object" || Object.keys(content).length === 0) {
      return { error: "Message content cannot be empty" };
    }

    const now = new Date();
    const res = await this.messages.insertOne({
      _id: new ObjectId(),
      sender,
      recipient,
      content,
      type,
      metadata,
      createdAt: now,
      updatedAt: now,
      edits: [],
    });

    return { messageId: res.insertedId.toHexString() };
  }

  /**
   * Action: editMessage (message: messageID, sender: UserID, content: Object) : (ok: Flag)
   * requires: message exists, sender of message is senderID, content is not empty
   * effects: add current content to edits list, update content to new content, set updatedAt := now
   */
  async editMessage(
    { messageId, sender, content }: { messageId: string; sender: User; content: Record<string, any> },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!content || typeof content !== "object" || Object.keys(content).length === 0) {
      return { error: "Message content cannot be empty" };
    }

    let oid: ObjectId;
    try {
      oid = new ObjectId(messageId);
    } catch {
      return { error: "Invalid message ID" };
    }

    const message = await this.messages.findOne({ _id: oid, sender });
    if (!message) {
      return { error: "Message not found or sender mismatch" };
    }

    const now = new Date();
    const editEntry = { content: message.content, timestamp: message.updatedAt };

    const res = await this.messages.updateOne(
      { _id: oid, sender },
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
    let oid: ObjectId;
    try {
      oid = new ObjectId(messageId);
    } catch {
      return { error: "Invalid message ID" };
    }

    const res = await this.messages.deleteOne({ _id: oid, sender });

    if (res.deletedCount === 0) {
      return { error: "Message not found or sender mismatch" };
    }

    return { ok: true };
  }

  /**
   * Query: _getMessagesBetween(userA: UserID, userB: UserID) : (messages: Set<Message>)
   * Retrieves messages exchanged between two specific users (either direction)
   */
  async _getMessagesBetween(
    { userA, userB }: { userA: User; userB: User },
  ): Promise<Array<{ messages: MessageState[] }>> {
    const messages = await this.messages.find({
      $or: [
        { sender: userA, recipient: userB },
        { sender: userB, recipient: userA },
      ],
    }).sort({ createdAt: 1 }).toArray();
    return [{ messages }];
  }

  /**
   * Query: _getRecentMessagesForUser(user: UserID) : (messages: Set<Message>)
   * Retrieves all messages where the user is either sender or recipient
   */
  async _getRecentMessagesForUser(
    { user }: { user: User },
  ): Promise<Array<{ messages: MessageState[] }>> {
    const messages = await this.messages.find({
      $or: [
        { sender: user },
        { recipient: user },
      ],
    }).sort({ createdAt: -1 }).toArray();
    return [{ messages }];
  }

  /**
   * Query: _getMessagesForRecipient(recipient: UserID) : (messages: Set<Message>)
   * Useful for group messages or specifically checking inbox
   */
  async _getMessagesForRecipient(
    { recipient }: { recipient: User },
  ): Promise<Array<{ messages: MessageState[] }>> {
    const messages = await this.messages.find({ recipient }).sort({ createdAt: -1 })
      .toArray();
    return [{ messages }];
  }

  /**
   * Query: _getConversationPartners(user: UserID) : (partners: Set<UserID>)
   * Finds all distinct users this user has messaged or received messages from
   */
  async _getConversationPartners(
    { user }: { user: User },
  ): Promise<Array<{ partners: User[] }>> {
    const senders = await this.messages.distinct("sender", { recipient: user });
    const recipients = await this.messages.distinct("recipient", { sender: user });
    const partners = [...new Set([...senders, ...recipients])] as User[];
    return [{ partners }];
  }
}
