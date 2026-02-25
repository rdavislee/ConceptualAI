import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
// Blocking [User]
export type User = ID;

const PREFIX = "Blocking" + ".";

interface BlockState {
  _id: ID;
  blocker: User;
  blocked: User;
  createdAt: Date;
}

/**
 * @concept Blocking
 * @purpose Prevent all interactions and visibility between two specific users.
 * @principle If a user blocks another user, then all mutual interactions are inhibited; if the block is later removed, the users can once again see and interact with each other's content.
 * @state a set of Blocks with blocker, blocked, createdAt
 */
export default class BlockingConcept {
  blocks: Collection<BlockState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.blocks = this.db.collection<BlockState>(PREFIX + "blocks");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.blocks.createIndex({ blocker: 1 });
    await this.blocks.createIndex({ blocker: 1, blocked: 1 }, { unique: true });
    await this.blocks.createIndex({ blocked: 1 });
    this.indexesCreated = true;
  }

  /**
   * Action: block (blocker: User, blocked: User) : (ok: Flag)
   * requires: blocker is not blocked, blocker != blocked
   * effects: create a block from blocker to blocked
   */
  async block(
    { blocker, blocked }: { blocker: User; blocked: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (blocker === blocked) {
      return { error: "Cannot block yourself" };
    }

    await this.ensureIndexes();
    try {
      await this.blocks.insertOne({
        _id: freshID(),
        blocker,
        blocked,
        createdAt: new Date(),
      });
      return { ok: true };
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code === 11000) {
        return { error: "Already blocked" };
      }
      throw e;
    }
  }

  /**
   * Lifecycle: deleteByBlocker (blocker: User) : (ok: Flag)
   * Deletes all blocks where the given user is the blocker. Use when blocker account is deleted.
   */
  async deleteByBlocker({ blocker }: { blocker: User }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.blocks.deleteMany({ blocker });
    return { ok: true };
  }

  /**
   * Lifecycle: deleteByBlocked (blocked: User) : (ok: Flag)
   * Deletes all blocks where the given user is the blocked. Use when blocked account is deleted.
   */
  async deleteByBlocked({ blocked }: { blocked: User }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.blocks.deleteMany({ blocked });
    return { ok: true };
  }

  /**
   * Action: unblock (blocker: User, blocked: User) : (ok: Flag)
   * requires: a block exists from blocker to blocked
   * effects: remove the block
   */
  async unblock(
    { blocker, blocked }: { blocker: User; blocked: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.blocks.deleteOne({ blocker, blocked });
    if (res.deletedCount === 0) {
      return { error: "Block not found" };
    }
    return { ok: true };
  }

  /**
   * Query: _isBlocked (userA: User, userB: User) : (blocked: Flag)
   * requires: true
   * effects: returns true if userA has blocked userB OR userB has blocked userA
   */
  async _isBlocked(
    { userA, userB }: { userA: User; userB: User },
  ): Promise<Array<{ blocked: boolean }>> {
    const block = await this.blocks.findOne({
      $or: [
        { blocker: userA, blocked: userB },
        { blocker: userB, blocked: userA },
      ],
    });
    return [{ blocked: !!block }];
  }

  /**
   * Query: _getBlockedUsers (blocker: User) : (users: Set<User>)
   * requires: true
   * effects: returns all users that the given blocker has blocked
   */
  async _getBlockedUsers(
    { blocker }: { blocker: User },
  ): Promise<Array<{ users: User[] }>> {
    await this.ensureIndexes();
    const blocks = await this.blocks.find({ blocker }).toArray();
    return [{ users: blocks.map((b) => b.blocked) }];
  }
}
