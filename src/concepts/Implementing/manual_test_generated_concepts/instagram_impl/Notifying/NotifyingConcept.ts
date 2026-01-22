import { Collection, Db } from "npm:mongodb";
import { Empty, ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

export type User = ID;

const PREFIX = "Notifying.";

interface NotificationState {
  _id: ID;
  recipient: User;
  title: string;
  body: string;
  deepLink?: string;
  isRead: boolean;
  createdAt: Date;
}

/**
 * @concept Notifying
 * @purpose To alert users of relevant events or interactions asynchronously.
 * @principle When an event occurs (e.g., a like or a message), a notification is created for the recipient. The recipient can view their list of notifications and mark them as read or dismiss them.
 * @state
 *   a set of Notifications with
 *     an id
 *     a recipient User
 *     a title String
 *     a body String
 *     a deepLink String
 *     a isRead Boolean
 *     a createdAt DateTime
 */
export default class NotifyingConcept {
  notifications: Collection<NotificationState>;

  constructor(private readonly db: Db) {
    this.notifications = this.db.collection<NotificationState>(PREFIX + "notifications");
  }

  /**
   * notify (recipient: User, title: String, body: String, deepLink?: String): ({notificationId: String})
   *
   * **requires** recipient exists.
   * **effects** creates a new `Notification` with `isRead` set to false and `createdAt` set to now.
   */
  async notify(
    { recipient, title, body, deepLink }: {
      recipient: User;
      title: string;
      body: string;
      deepLink?: string;
    },
  ): Promise<{ notificationId: string } | { error: string }> {
    if (!recipient) {
      return { error: "Recipient is required" };
    }
    if (!title || !body) {
      return { error: "Title and body are required" };
    }

    const _id = freshID();
    const notification: NotificationState = {
      _id,
      recipient,
      title,
      body,
      deepLink,
      isRead: false,
      createdAt: new Date(),
    };

    await this.notifications.insertOne(notification);

    return { notificationId: _id };
  }

  /**
   * markAsRead (notificationId: String, user: User): ({} | {error: String})
   *
   * **requires** notification exists and belongs to `user`.
   * **effects** sets `isRead` to true.
   */
  async markAsRead(
    { notificationId, user }: { notificationId: string; user: User },
  ): Promise<Empty | { error: string }> {
    const res = await this.notifications.updateOne(
      { _id: notificationId as ID, recipient: user },
      { $set: { isRead: true } },
    );

    if (res.matchedCount === 0) {
      return { error: "Notification not found or does not belong to user" };
    }

    return {};
  }

  /**
   * delete (notificationId: String, user: User): ({} | {error: String})
   *
   * **requires** notification exists and belongs to `user`.
   * **effects** deletes the notification.
   */
  async delete(
    { notificationId, user }: { notificationId: string; user: User },
  ): Promise<Empty | { error: string }> {
    const res = await this.notifications.deleteOne({
      _id: notificationId as ID,
      recipient: user,
    });

    if (res.deletedCount === 0) {
      return { error: "Notification not found or does not belong to user" };
    }

    return {};
  }

  /**
   * _getUnread (user: User): (Notification)
   *
   * **effects** returns all notifications for the user where `isRead` is false, sorted by `createdAt` descending.
   */
  async _getUnread(
    { user }: { user: User },
  ): Promise<Array<{ notification: NotificationState }>> {
    const notifications = await this.notifications.find({
      recipient: user,
      isRead: false,
    }).sort({ createdAt: -1 }).toArray();

    return notifications.map((n) => ({ notification: n }));
  }

  /**
   * _getAll (user: User): (Notification)
   *
   * **effects** returns all notifications for the user, sorted by `createdAt` descending.
   */
  async _getAll(
    { user }: { user: User },
  ): Promise<Array<{ notification: NotificationState }>> {
    const notifications = await this.notifications.find({
      recipient: user,
    }).sort({ createdAt: -1 }).toArray();

    return notifications.map((n) => ({ notification: n }));
  }
}