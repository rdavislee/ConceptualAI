import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
// Notifying [User, Item]
export type User = ID;
export type Item = ID;

const PREFIX = "Notifying" + ".";

interface NotificationState {
  _id: ID;
  recipient: User;
  trigger: Item;
  content: Record<string, any>;
  status: "unseen" | "seen" | "read";
  type?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  seenAt?: Date;
  readAt?: Date;
}

/**
 * @concept Notifying
 * @purpose Alert a user to events of interest and track whether they have been acknowledged.
 * @principle If an event occurs and a notification is created for a user, then the user identifies the event via the notification; once the user views or interacts with the notification, its status is updated to reflect that it has been seen or read.
 * @state a set of Notifications with recipient, trigger, content, status, type, metadata, createdAt...
 */
export default class NotifyingConcept {
  notifications: Collection<NotificationState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.notifications = this.db.collection<NotificationState>(PREFIX + "notifications");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.notifications.createIndex({ recipient: 1, createdAt: -1 }),
      this.notifications.createIndex({ recipient: 1, status: 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: notify (recipient: User, trigger: Item, content: Object, type?: String, metadata?: Object) : (notificationId: Notification)
   */
  async notify(
    { recipient, trigger, content, type, metadata }: {
      recipient: User;
      trigger: Item;
      content: Record<string, any>;
      type?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<{ notificationId: string } | { error: string }> {
    if (!content || typeof content !== "object" || Object.keys(content).length === 0) {
      return { error: "Notification content cannot be empty" };
    }

    const now = new Date();
    const notificationId = freshID();
    await this.notifications.insertOne({
      _id: notificationId,
      recipient,
      trigger,
      content,
      status: "unseen",
      type,
      metadata,
      createdAt: now,
    });

    return { notificationId };
  }

  /**
   * Action: markAsSeen (notificationId: Notification, recipient: User) : (ok: Flag)
   */
  async markAsSeen(
    { notificationId, recipient }: { notificationId: string; recipient: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.notifications.updateOne(
      { _id: notificationId as ID, recipient, status: "unseen" },
      {
        $set: { status: "seen", seenAt: new Date() },
      },
    );

    if (res.matchedCount === 0) {
      // Check if it's already seen/read or if it's a mismatch
      const exists = await this.notifications.findOne({ _id: notificationId as ID, recipient });
      if (!exists) return { error: "Notification not found or recipient mismatch" };
      return { ok: true }; // Return true if already seen/read
    }

    return { ok: true };
  }

  /**
   * Action: markAsRead (notificationId: Notification, recipient: User) : (ok: Flag)
   */
  async markAsRead(
    { notificationId, recipient }: { notificationId: string; recipient: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    const now = new Date();
    const res = await this.notifications.updateOne(
      { _id: notificationId as ID, recipient, status: { $ne: "read" } },
      { $set: { status: "read", readAt: now } },
    );

    if (res.matchedCount === 0) {
      const exists = await this.notifications.findOne({ _id: notificationId as ID, recipient });
      if (!exists) return { error: "Notification not found or recipient mismatch" };
      return { ok: true }; // Already read
    }

    // Ensure seenAt is set if it wasn't before
    await this.notifications.updateOne(
      { _id: notificationId as ID, recipient, seenAt: { $exists: false } },
      { $set: { seenAt: now } },
    );

    return { ok: true };
  }

  /**
   * Delete lifecycle: remove all notifications for a recipient (for account deletion).
   */
  async deleteByRecipient({ recipient }: { recipient: User }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.notifications.deleteMany({ recipient });
    return { ok: true };
  }

  /**
   * Delete lifecycle: remove all notifications triggered by an item (for item deletion).
   */
  async deleteByTrigger({ trigger }: { trigger: Item }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.notifications.deleteMany({ trigger });
    return { ok: true };
  }

  /**
   * Action: deleteNotification (notificationId: Notification, recipient: User) : (ok: Flag)
   */
  async deleteNotification(
    { notificationId, recipient }: { notificationId: string; recipient: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.notifications.deleteOne({ _id: notificationId as ID, recipient });

    if (res.deletedCount === 0) {
      return { error: "Notification not found or recipient mismatch" };
    }

    return { ok: true };
  }

  /**
   * Query: _getNotificationsForUser (user: User, status?: String) : (notifications: Set<Notification>)
   */
  async _getNotificationsForUser(
    { user, status }: { user: User; status?: string },
  ): Promise<Array<{ notifications: NotificationState[] }>> {
    await this.ensureIndexes();
    const filter: any = { recipient: user };
    if (status) {
      filter.status = status;
    }
    const notifications = await this.notifications.find(filter).sort({ createdAt: -1 })
      .toArray();
    return [{ notifications }];
  }

  /**
   * Query: _getUnreadCount (user: User) : (count: Number)
   */
  async _getUnreadCount(
    { user }: { user: User },
  ): Promise<Array<{ count: number }>> {
    await this.ensureIndexes();
    const count = await this.notifications.countDocuments({
      recipient: user,
      status: { $in: ["unseen", "seen"] },
    });
    return [{ count }];
  }

  /**
   * Query: _allNotifications () : (notifications: Set<Notification>)
   */
  async _allNotifications(): Promise<Array<{ notifications: NotificationState[] }>> {
    await this.ensureIndexes();
    const notifications = await this.notifications.find({}).sort({ createdAt: -1 })
      .toArray();
    return [{ notifications }];
  }
}
