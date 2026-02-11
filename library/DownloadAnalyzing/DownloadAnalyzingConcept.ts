import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// DownloadAnalyzing [Item, User]
export type Item = ID;
export type User = ID | "anonymous";

const PREFIX = "DownloadAnalyzing" + ".";

interface ItemState {
  _id: Item;
  downloads: Array<{
    user: User;
    at: Date;
  }>;
}

/**
 * @concept DownloadAnalyzing
 * @purpose Record that a user downloaded an item, enabling analytics and rate/abuse insights (analysis via queries/consumers).
 * @principle When a download occurs it is recorded with time and identities; later, aggregates are computed via queries; records are append-only.
 * @state
 *  a set of items with
 *    a set of Downloads with
 *      a userID
 *      a DateTime
 */
export default class DownloadAnalyzingConcept {
  items: Collection<ItemState>;

  constructor(private readonly db: Db) {
    this.items = this.db.collection<ItemState>(PREFIX + "items");
  }

  /**
   * Lifecycle: deleteByItem (item: Item) : (ok: Flag)
   * Deletes all download records for the given item. Use when item is deleted.
   */
  async deleteByItem({ item }: { item: Item }): Promise<{ ok: boolean }> {
    await this.items.deleteOne({ _id: item });
    return { ok: true };
  }

  /**
   * Lifecycle: deleteByUser (user: User) : (ok: Flag)
   * Removes all download records by the given user from all items. Use when user is deleted.
   */
  async deleteByUser({ user }: { user: User }): Promise<{ ok: boolean }> {
    await this.items.updateMany(
      { "downloads.user": user },
      { $pull: { downloads: { user } } },
    );
    return { ok: true };
  }

  /**
   * Action: record (item: Item, user?: userID, at: DateTime) : (ok: Flag)
   * requires: item is provided
   * effects: create download record; if user is not provided, record as anonymous
   */
  async record(
    { item, user, at }: { item?: Item; user?: User; at: Date },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!item) {
      return { error: "Item is required" };
    }
    // Use a sentinel for anonymous/unauthenticated downloads
    const recordedUser: User = user ?? "anonymous";

    await this.items.updateOne(
      { _id: item },
      { $push: { downloads: { user: recordedUser, at } } },
      { upsert: true },
    );
    return { ok: true };
  }

  /**
   * Query: _countForItem(item: Item) : (count: Number)
   */
  async _countForItem(
    { item, from, to }: { item: Item; from?: Date; to?: Date },
  ): Promise<Array<{ count: number }>> {
    const doc = await this.items.findOne(
      { _id: item },
      { projection: { downloads: 1 } },
    );

    if (!doc || !doc.downloads) {
      return [{ count: 0 }];
    }

    // If no window provided, return total
    if (!from && !to) {
      return [{ count: doc.downloads.length }];
    }

    const start = from ?? new Date(-8640000000000000); // min date
    const end = to ?? new Date(8640000000000000); // max date
    const inWindow = doc.downloads.filter((d) => d.at >= start && d.at <= end);
    return [{ count: inWindow.length }];
  }
}
