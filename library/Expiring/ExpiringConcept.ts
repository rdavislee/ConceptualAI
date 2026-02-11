import { Collection, Db, ObjectId } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Expiring [Item]
export type Item = ID;

const PREFIX = "Expiring" + ".";

interface ExpirationState {
  _id: ObjectId;
  item: Item;
  expiresAt: Date;
}

/**
 * @concept Expiring
 * @purpose Manage the limited availability of items over time.
 * @principle If an item is set to expire at a certain time, then it remains accessible until that time; after the expiration time has passed, the item is considered expired and any queries or actions checking for availability will fail.
 * @state a set of Expirations with item, expiresAt
 */
export default class ExpiringConcept {
  expirations: Collection<ExpirationState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.expirations = this.db.collection<ExpirationState>(PREFIX + "expirations");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.expirations.createIndex({ item: 1 });
    await this.expirations.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
    this.indexesCreated = true;
  }

  /**
   * Lifecycle: deleteByItem (item: Item) : (ok: Flag)
   * Removes the expiration record for the item. Use when item is deleted.
   */
  async deleteByItem({ item }: { item: Item }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.expirations.deleteMany({ item });
    return { ok: true };
  }

  /**
   * Action: setExpiry (item: Item, expiresAt: DateTime) : (ok: Flag)
   * requires: expiresAt is in the future
   * effects: associate the item with the given expiration time (replaces any existing expiry)
   */
  async setExpiry(
    { item, expiresAt }: { item: Item; expiresAt: Date },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (expiresAt.getTime() <= Date.now()) {
      return { error: "Expiration must be in the future" };
    }

    await this.ensureIndexes();
    await this.expirations.updateOne(
      { item },
      { $set: { expiresAt } },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * Action: cancelExpiry (item: Item) : (ok: Flag)
   * requires: item has an active (future) expiry set
   * effects: remove the expiration association for the item
   */
  async cancelExpiry(
    { item }: { item: Item },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.expirations.deleteOne({ item });
    if (res.deletedCount === 0) {
      return { error: "No expiry found for this item" };
    }
    return { ok: true };
  }

  /**
   * Query: _isExpired (item: Item) : (expired: Flag)
   * requires: true
   * effects: returns true if current time > expiresAt, false otherwise.
   */
  async _isExpired(
    { item }: { item: Item },
  ): Promise<Array<{ expired: boolean }>> {
    const record = await this.expirations.findOne({ item });
    if (!record) return [{ expired: false }];
    return [{ expired: record.expiresAt.getTime() < Date.now() }];
  }

  /**
   * Query: _getExpiredItems () : (items: Set<Item>)
   * requires: true
   * effects: returns all items whose expiresAt time is in the past
   */
  async _getExpiredItems(): Promise<Array<{ items: Item[] }>> {
    const expired = await this.expirations.find({
      expiresAt: { $lt: new Date() },
    }).toArray();
    return [{ items: expired.map((e) => e.item) }];
  }

  /**
   * Query: _getRemainingTime (item: Item) : (remainingMs: Number)
   * requires: true
   * effects: returns the number of milliseconds remaining until the item expires, or 0 if it has already expired or no expiry is set.
   */
  async _getRemainingTime(
    { item }: { item: Item },
  ): Promise<Array<{ remainingMs: number }>> {
    const record = await this.expirations.findOne({ item });
    if (!record) return [{ remainingMs: 0 }];
    const remaining = record.expiresAt.getTime() - Date.now();
    return [{ remainingMs: Math.max(0, remaining) }];
  }
}
