import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Following [Follower, Followed]
export type Follower = ID;
export type Followed = ID;

const PREFIX = "Following" + ".";

// State: a set of Followed with a user ID, a set of Followers...
interface FollowedState {
  _id: Followed; // user ID
  followers: Array<{
    user: Follower;
    at: Date;
  }>;
}

// State: a set of Followers with a user ID, a set of Following...
interface FollowerState {
  _id: Follower; // user ID
  following: Array<{
    user: Followed;
    at: Date;
  }>;
}

/**
 * @concept Following
 * @purpose Maintain a directed social graph where users (followers) can subscribe to updates or signals from other users (followed).
 * @principle A user can follow another user (including themselves) once; following is asymmetric.
 * @state
 *  a set of Followed with a user ID, a set of Followers
 *  a set of Followers with a user ID, a set of Following
 */
export default class FollowingConcept {
  followed: Collection<FollowedState>;
  followers: Collection<FollowerState>;

  constructor(private readonly db: Db) {
    this.followed = this.db.collection<FollowedState>(PREFIX + "followed");
    this.followers = this.db.collection<FollowerState>(PREFIX + "followers");
  }

  /**
   * Lifecycle: deleteByFollower (follower: Follower) : (ok: Flag)
   * Removes all following relationships where the given user is the follower. Use when follower account is deleted.
   */
  async deleteByFollower({ follower }: { follower: Follower }): Promise<{ ok: boolean }> {
    const doc = await this.followers.findOne({ _id: follower });
    if (!doc?.following?.length) return { ok: true };
    for (const f of doc.following) {
      await this.followed.updateOne(
        { _id: f.user },
        { $pull: { followers: { user: follower } } },
      );
    }
    await this.followers.deleteOne({ _id: follower });
    return { ok: true };
  }

  /**
   * Lifecycle: deleteByFollowed (followed: Followed) : (ok: Flag)
   * Removes all following relationships where the given user is the followed. Use when followed account is deleted.
   */
  async deleteByFollowed({ followed }: { followed: Followed }): Promise<{ ok: boolean }> {
    const doc = await this.followed.findOne({ _id: followed });
    if (!doc?.followers?.length) {
      await this.followed.deleteOne({ _id: followed });
      return { ok: true };
    }
    for (const f of doc.followers) {
      await this.followers.updateOne(
        { _id: f.user },
        { $pull: { following: { user: followed } } },
      );
    }
    await this.followed.deleteOne({ _id: followed });
    return { ok: true };
  }

  /**
   * Action: follow (follower: userID, followed: userID) : (ok: Flag)
   * requires: no following exists for (follower, followed)
   * effects: create relationship with at := now and adds to both sets
   */
  async follow(
    { follower, followed }: { follower: Follower; followed: Followed },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (follower === followed) {
      return { error: "Cannot follow yourself" };
    }
    const existing = await this.followers.findOne({
      _id: follower,
      "following.user": followed,
    });
    if (existing) {
      return { error: "Already following this user" };
    }

    const at = new Date();

    // Add to both sets
    await Promise.all([
      this.followed.updateOne(
        { _id: followed },
        { $push: { followers: { user: follower, at } } },
        { upsert: true },
      ),
      this.followers.updateOne(
        { _id: follower },
        { $push: { following: { user: followed, at } } },
        { upsert: true },
      ),
    ]);

    return { ok: true };
  }

  /**
   * Action: unfollow (follower: userID, followed: userID) : (ok: Flag)
   * requires: following exists for (follower, followed)
   * effects: delete that relationship from both sets
   */
  async unfollow(
    { follower, followed }: { follower: Follower; followed: Followed },
  ): Promise<{ ok: boolean } | { error: string }> {
    const existing = await this.followers.findOne({
      _id: follower,
      "following.user": followed,
    });
    if (!existing) {
      return { error: "Not following this user" };
    }

    // Remove from both sets
    await Promise.all([
      this.followed.updateOne(
        { _id: followed },
        { $pull: { followers: { user: follower } } },
      ),
      this.followers.updateOne(
        { _id: follower },
        { $pull: { following: { user: followed } } },
      ),
    ]);

    return { ok: true };
  }

  /**
   * Query: _isFollowing(follower: userID, followed: userID) : (following: Flag)
   */
  async _isFollowing(
    { follower, followed }: { follower: Follower; followed: Followed },
  ): Promise<Array<{ following: boolean }>> {
    const doc = await this.followers.findOne(
      { _id: follower, "following.user": followed },
      { projection: { _id: 1 } },
    );
    return [{ following: !!doc }];
  }

  /**
   * Query: _followers(followed: userID) : (users: Set<userID>)
   */
  async _followers(
    { followed }: { followed: Followed },
  ): Promise<Array<{ users: Follower[] }>> {
    const doc = await this.followed.findOne(
      { _id: followed },
      { projection: { followers: 1 } },
    );
    const users = doc?.followers?.map((f) => f.user) ?? [];
    return [{ users }];
  }

  /**
   * Query: _following(follower: userID) : (users: Set<userID>)
   */
  async _following(
    { follower }: { follower: Follower },
  ): Promise<Array<{ users: Followed[] }>> {
    const doc = await this.followers.findOne(
      { _id: follower },
      { projection: { following: 1 } },
    );
    const users = doc?.following?.map((f) => f.user) ?? [];
    return [{ users }];
  }

  /**
   * Query: _getFollowerCount(followed: userID) : (count: Number)
   */
  async _getFollowerCount(
    { followed }: { followed: Followed },
  ): Promise<Array<{ count: number }>> {
    const doc = await this.followed.findOne(
      { _id: followed },
      { projection: { followers: 1 } },
    );
    const count = doc?.followers?.length ?? 0;
    return [{ count }];
  }

  /**
   * Query: _getFollowingCount(follower: userID) : (count: Number)
   */
  async _getFollowingCount(
    { follower }: { follower: Follower },
  ): Promise<Array<{ count: number }>> {
    const doc = await this.followers.findOne(
      { _id: follower },
      { projection: { following: 1 } },
    );
    const count = doc?.following?.length ?? 0;
    return [{ count }];
  }
}
