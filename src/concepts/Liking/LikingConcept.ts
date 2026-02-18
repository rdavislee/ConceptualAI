import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Liking [Item, User]
export type Item = ID;
export type User = ID;

const PREFIX = "Liking" + ".";

// State: a set of Items with an item ID, a set of Likes...
interface ItemState {
  _id: Item; // item ID
  likes: Array<{
    user: User;
    at: Date;
  }>;
}

// State: a set of Users with a user ID, a set of Likes...
interface UserState {
  _id: User; // user ID
  likes: Array<{
    item: Item;
    at: Date;
  }>;
}

/**
 * @concept Liking
 * @purpose Let users express a binary preference for items, preventing duplicates and enabling reversals.
 * @principle A user can like an item once; unlike removes the relation.
 * @state
 *  a set of Items with an item ID, a set of Likes
 *  a set of Users with a user ID, a set of Likes
 */
export default class LikingConcept {
  items: Collection<ItemState>;
  users: Collection<UserState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.items = this.db.collection<ItemState>(PREFIX + "items");
    this.users = this.db.collection<UserState>(PREFIX + "users");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.items.createIndex({ "likes.user": 1 }),
      this.users.createIndex({ "likes.item": 1 }),
      this.users.createIndex({ _id: 1, "likes.item": 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: like (item: itemID, user: userID) : (ok: Flag)
   * requires: no like exists for (item,user)
   * effects: create like with at := now and adds like to both sets
   */
  async like(
    { item, user }: { item: Item; user: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    // Check if like already exists (findOne for existence only).
    const exists = await this.users.findOne(
      { _id: user, "likes.item": item },
      { projection: { _id: 1 } },
    );
    if (exists) {
      return { error: "Like already exists for this (item,user) pair" };
    }

    const at = new Date();

    // Add to both sets
    await Promise.all([
      this.items.updateOne(
        { _id: item },
        { $push: { likes: { user, at } } },
        { upsert: true },
      ),
      this.users.updateOne(
        { _id: user },
        { $push: { likes: { item, at } } },
        { upsert: true },
      ),
    ]);

    return { ok: true };
  }

  /**
   * Action: unlike (item: itemID, user: userID) : (ok: Flag)
   * requires: like exists for (item,user)
   * effects: delete that like from both sets
   */
  async unlike(
    { item, user }: { item: Item; user: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    // Check existence first (findOne for existence only).
    const exists = await this.users.findOne(
      { _id: user, "likes.item": item },
      { projection: { _id: 1 } },
    );
    if (!exists) {
      return { error: "No existing like to remove for this (item,user) pair" };
    }

    // Remove from both sets
    await Promise.all([
      this.items.updateOne(
        { _id: item },
        { $pull: { likes: { user: user } } },
      ),
      this.users.updateOne(
        { _id: user },
        { $pull: { likes: { item: item } } },
      ),
    ]);

    return { ok: true };
  }

  /**
   * Query: _isLiked(item: itemID, user: userID) : (liked: Flag)
   */
  async _isLiked(
    { item, user }: { item: Item; user: User },
  ): Promise<Array<{ liked: boolean }>> {
    await this.ensureIndexes();
    const exists = await this.users.findOne(
      { _id: user, "likes.item": item },
      { projection: { _id: 1 } },
    );
    return [{ liked: !!exists }];
  }

  /**
   * Query: _countForItem(item: itemID) : (n: Number)
   */
  async _countForItem(
    { item }: { item: Item },
  ): Promise<Array<{ n: number }>> {
    const doc = await this.items.findOne(
      { _id: item },
      { projection: { likes: 1 } },
    );
    const n = doc?.likes?.length ?? 0;
    return [{ n }];
  }

  /**
   * Query: _countForItems(items: List<itemID>) : (counts: List<{item: itemID, n: Number}>)
   */
  async _countForItems(
    { items }: { items: Item[] },
  ): Promise<Array<{ counts: Array<{ item: Item; n: number }> }>> {
    if (!Array.isArray(items) || items.length === 0) {
      return [{ counts: [] }];
    }

    const docs = await this.items.find(
      { _id: { $in: items } },
      { projection: { likes: 1 } },
    ).toArray();

    const countsByItem = new Map<Item, number>();
    for (const doc of docs) {
      countsByItem.set(doc._id, doc.likes?.length ?? 0);
    }

    const counts = items.map((item) => ({
      item,
      n: countsByItem.get(item) ?? 0,
    }));

    return [{ counts }];
  }

  /**
   * Query: _likedItems(user: userID) : (items: Set<itemID>)
   */
  async _likedItems(
    { user }: { user: User },
  ): Promise<Array<{ items: Item[] }>> {
    const doc = await this.users.findOne(
      { _id: user },
      { projection: { likes: 1 } },
    );
    const items = doc?.likes?.map((l) => l.item) ?? [];
    return [{ items }];
  }

  /**
   * Delete lifecycle: remove all likes by a user (for account deletion).
   */
  async deleteByUser({ user }: { user: User }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    const userDoc = await this.users.findOne(
      { _id: user },
      { projection: { likes: 1 } },
    );
    if (!userDoc?.likes?.length) {
      await this.users.deleteOne({ _id: user });
      return { ok: true };
    }
    const itemIds = userDoc.likes.map((l) => l.item);
    await Promise.all([
      ...itemIds.map((item) =>
        this.items.updateOne(
          { _id: item },
          { $pull: { likes: { user } } },
        )
      ),
      this.users.deleteOne({ _id: user }),
    ]);
    return { ok: true };
  }

  /**
   * Delete lifecycle: remove all likes for an item (for item deletion).
   */
  async deleteByItem({ item }: { item: Item }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    const itemDoc = await this.items.findOne(
      { _id: item },
      { projection: { likes: 1 } },
    );
    if (!itemDoc?.likes?.length) {
      await this.items.deleteOne({ _id: item });
      return { ok: true };
    }
    const userIds = itemDoc.likes.map((l) => l.user);
    await Promise.all([
      ...userIds.map((u) =>
        this.users.updateOne(
          { _id: u },
          { $pull: { likes: { item } } },
        )
      ),
      this.items.deleteOne({ _id: item }),
    ]);
    return { ok: true };
  }

  /**
   * Query: _getLikeCountForUser(user: userID) : (n: Number)
   */
  async _getLikeCountForUser(
    { user }: { user: User },
  ): Promise<Array<{ n: number }>> {
    const doc = await this.users.findOne(
      { _id: user },
      { projection: { likes: 1 } },
    );
    const n = doc?.likes?.length ?? 0;
    return [{ n }];
  }
}
