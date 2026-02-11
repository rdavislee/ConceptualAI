import { Collection, Db, ObjectId } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Snapping [User, Media]
export type User = ID;
export type Media = Record<string, any>; // Default generic type
export type Snap = string;

const PREFIX = "Snapping" + ".";

const STATUSES = ["sent", "delivered", "opened"] as const;
type Status = typeof STATUSES[number];

interface SnapState<TMedia> {
  _id: ObjectId;
  sender: User;
  recipient: User;
  media: TMedia;
  status: Status;
  sentAt: Date;
  deliveredAt?: Date;
  openedAt?: Date;
}

/**
 * @concept Snapping
 * @purpose Enables users to exchange ephemeral media messages that are deleted after viewing.
 */
export default class SnappingConcept<TMedia = Record<string, any>> {
  snaps: Collection<SnapState<TMedia>>;

  constructor(private readonly db: Db) {
    this.snaps = this.db.collection<SnapState<TMedia>>(PREFIX + "snaps");
  }

  async ensureIndexes(): Promise<void> {
    await this.snaps.createIndex({ recipient: 1, status: 1, sentAt: -1 });
    await this.snaps.createIndex({ sender: 1, sentAt: -1 });
  }

  /**
   * Action: send (sender: User, recipient: User, media: Media) : (snap: Snap)
   */
  async send(
    { sender, recipient, media }: { sender: User; recipient: User; media: TMedia },
  ): Promise<{ snap: string } | { error: string }> {
    if (sender === recipient) {
      return { error: "Cannot snap yourself" };
    }

    const now = new Date();
    const res = await this.snaps.insertOne({
      _id: new ObjectId(),
      sender,
      recipient,
      media,
      status: "sent",
      sentAt: now,
    });

    return { snap: res.insertedId.toHexString() };
  }

  /**
   * Action: markDelivered (snap: Snap) : (ok: Flag)
   */
  async markDelivered(
    { snap }: { snap: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    let oid: ObjectId;
    try {
      oid = new ObjectId(snap);
    } catch {
      return { error: "Invalid snap ID" };
    }

    const res = await this.snaps.updateOne(
      { _id: oid, status: "sent" },
      { $set: { status: "delivered", deliveredAt: new Date() } },
    );

    if (res.matchedCount === 0) {
      return { error: "Snap not found or already delivered/opened" };
    }

    return { ok: true };
  }

  /**
   * Action: open (snap: Snap, recipient: User) : (ok: Flag)
   */
  async open(
    { snap, recipient }: { snap: string; recipient: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    let oid: ObjectId;
    try {
      oid = new ObjectId(snap);
    } catch {
      return { error: "Invalid snap ID" };
    }

    const res = await this.snaps.updateOne(
      {
        _id: oid,
        recipient,
        status: { $in: ["sent", "delivered"] }
      },
      { $set: { status: "opened", openedAt: new Date() } },
    );

    if (res.matchedCount === 0) {
      return { error: "Snap not found, recipient mismatch, or already opened" };
    }

    return { ok: true };
  }

  /**
   * Action: delete (snap: Snap) : (ok: Flag)
   */
  async delete(
    { snap }: { snap: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    let oid: ObjectId;
    try {
      oid = new ObjectId(snap);
    } catch {
      return { error: "Invalid snap ID" };
    }

    const res = await this.snaps.deleteOne({ _id: oid });
    if (res.deletedCount === 0) {
      return { error: "Snap not found" };
    }

    return { ok: true };
  }

  /**
   * Cleanup: deleteBySender (sender) - removes all snaps sent by user (e.g. account deletion).
   */
  async deleteBySender({ sender }: { sender: User }): Promise<{ ok: boolean }> {
    await this.snaps.deleteMany({ sender });
    return { ok: true };
  }

  /**
   * Cleanup: deleteByRecipient (recipient) - removes all snaps received by user (e.g. account deletion).
   */
  async deleteByRecipient({ recipient }: { recipient: User }): Promise<{ ok: boolean }> {
    await this.snaps.deleteMany({ recipient });
    return { ok: true };
  }

  /**
   * Query: _getSnapsForUser (user: User) : (snaps: Set<Snap>)
   */
  async _getSnapsForUser(
    { user }: { user: User },
  ): Promise<Array<{ snaps: SnapState<TMedia>[] }>> {
    const snaps = await this.snaps.find({
      recipient: user,
      status: { $ne: "opened" },
    }).sort({ sentAt: -1 }).toArray();
    return [{ snaps }];
  }

  /**
   * Query: _getSentSnaps (user: User) : (snaps: Set<Snap>)
   */
  async _getSentSnaps(
    { user }: { user: User },
  ): Promise<Array<{ snaps: SnapState<TMedia>[] }>> {
    const snaps = await this.snaps.find({ sender: user }).sort({ sentAt: -1 }).toArray();
    return [{ snaps }];
  }

  /**
   * Query: _getSnapsBetweenUsers (userA: User, userB: User) : (snaps: Set<Snap>)
   */
  async _getSnapsBetweenUsers(
    { userA, userB }: { userA: User; userB: User },
  ): Promise<Array<{ snaps: SnapState<TMedia>[] }>> {
    const snaps = await this.snaps.find({
      $or: [
        { sender: userA, recipient: userB },
        { sender: userB, recipient: userA },
      ],
    }).sort({ sentAt: -1 }).toArray();
    return [{ snaps }];
  }
}
