import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Profiling [User]
export type User = ID;

const PREFIX = "Profiling" + ".";

// State: a set of Profiles with a user ID, a name...
interface ProfileState {
  _id: User; // user ID
  username: string;
  name: string;
  bio: string;
  bioImageUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept Profiling
 * @purpose Allows users to present a public identity and additional information about themselves to others.
 * @principle If a user creates a profile, then it becomes visible to others with their name and bio; the user can later update the contents of their profile or delete it entirely.
 * @state
 *  a set of Profiles with a user ID, a name String, a bio String, a bioImageUrl String, a createdAt DateTime, an updatedAt DateTime
 */
export default class ProfilingConcept {
  profiles: Collection<ProfileState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.profiles = this.db.collection<ProfileState>(PREFIX + "profiles");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.profiles.createIndex({ username: 1 }, { unique: true });
    this.indexesCreated = true;
  }

  /**
   * Action: createProfile (user: User, username: String, name: String, bio?: String, bioImageUrl?: String) : (ok: Flag)
   * requires: profile for user does not already exist
   * effects: create profile for user with name, bio, bioImageUrl, createdAt := now, updatedAt := now
   */
  async createProfile(
    { user, username, name, bio, bioImageUrl }: {
      user: User;
      username: string;
      name: string;
      bio?: string;
      bioImageUrl?: string;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    const existing = await this.profiles.findOne({ _id: user });
    if (existing) {
      return { error: "Profile already exists" };
    }

    const usernameExists = await this.profiles.findOne({ username });
    if (usernameExists) {
      return { error: "Username already taken" };
    }

    const now = new Date();
    try {
      await this.profiles.insertOne({
        _id: user,
        username,
        name,
        bio: bio ?? "",
        bioImageUrl: bioImageUrl ?? "",
        createdAt: now,
        updatedAt: now,
      });
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code === 11000) {
        return { error: "Username already taken" };
      }
      throw e;
    }

    return { ok: true };
  }

  /**
   * Action: updateProfile (user: userID, name?: String, bio?: String, bioImageUrl?: String) : (ok: Flag)
   * requires: profile for user exists, at least one field provided
   * effects: update specified fields and set updatedAt := now
   */
  async updateProfile(
    { user, username, name, bio, bioImageUrl }: {
      user: User;
      username?: string;
      name?: string;
      bio?: string;
      bioImageUrl?: string;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    if (username === undefined && name === undefined && bio === undefined && bioImageUrl === undefined) {
      return { error: "No fields provided for update" };
    }

    if (username !== undefined) {
      const usernameExists = await this.profiles.findOne({ username, _id: { $ne: user } });
      if (usernameExists) {
        return { error: "Username already taken" };
      }
    }

    const now = new Date();
    const update: any = { $set: { updatedAt: now } };

    if (username !== undefined) update.$set.username = username;
    if (name !== undefined) update.$set.name = name;
    if (bio !== undefined) update.$set.bio = bio;
    if (bioImageUrl !== undefined) update.$set.bioImageUrl = bioImageUrl;

    try {
      const result = await this.profiles.updateOne(
        { _id: user },
        update,
        { upsert: false },
      );

      if (result.matchedCount === 0) {
        return { error: "Profile does not exist" };
      }
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code === 11000) {
        return { error: "Username already taken" };
      }
      throw e;
    }

    return { ok: true };
  }

  /**
   * Action: changeUsername (user: User, newUsername: String) : (ok: Flag)
   * requires: profile for user exists, newUsername is unique
   * effects: set profile's username to newUsername and set updatedAt := now
   */
  async changeUsername(
    { user, newUsername }: { user: User; newUsername: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    const usernameExists = await this.profiles.findOne({ username: newUsername, _id: { $ne: user } });
    if (usernameExists) {
      return { error: "Username already taken" };
    }

    const now = new Date();
    try {
      const result = await this.profiles.updateOne(
        { _id: user },
        { $set: { username: newUsername, updatedAt: now } },
      );

      if (result.matchedCount === 0) {
        return { error: "Profile does not exist" };
      }
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code === 11000) {
        return { error: "Username already taken" };
      }
      throw e;
    }

    return { ok: true };
  }

  /**
   * Action: deleteProfile (user: userID) : (ok: Flag)
   * requires: profile exists
   * effects: deletes the profile
   */
  async deleteProfile(
    { user }: { user: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    const result = await this.profiles.deleteOne({ _id: user });
    if (result.deletedCount === 0) {
      return { error: "Profile does not exist" };
    }
    return { ok: true };
  }

  /**
   * Query: _getProfile(user: userID) : (profile: Profile)
   */
  async _getProfile(
    { user }: { user: User },
  ): Promise<Array<{ profile: ProfileState | null }>> {
    const profile = await this.profiles.findOne({ _id: user });
    return [{ profile }];
  }

  /**
   * Query: _getProfileByUsername (username: String) : (profile: Profile | null)
   */
  async _getProfileByUsername(
    { username }: { username: string },
  ): Promise<Array<{ profile: ProfileState | null }>> {
    const profile = await this.profiles.findOne({ username });
    return [{ profile }];
  }

  /**
   * Query: _getProfilesByIds(users: List<User>) : (profiles: List<Profile>)
   */
  async _getProfilesByIds(
    { users }: { users: User[] },
  ): Promise<Array<{ profiles: ProfileState[] }>> {
    if (!Array.isArray(users) || users.length === 0) {
      return [{ profiles: [] }];
    }

    const docs = await this.profiles.find({ _id: { $in: users } }).toArray();
    const byUser = new Map<User, ProfileState>();
    for (const doc of docs) {
      byUser.set(doc._id, doc);
    }

    const profiles = users
      .map((u) => byUser.get(u))
      .filter((p): p is ProfileState => p !== undefined);

    return [{ profiles }];
  }

  /**
   * Query: searchProfiles (query: String) : (profiles: Profile[])
   */
  async searchProfiles(
    { query }: { query: string },
  ): Promise<Array<{ profiles: ProfileState[] }>> {
    await this.ensureIndexes();
    if (!query || query.trim() === "") {
      return [{ profiles: [] }];
    }

    const regex = { $regex: query.trim(), $options: "i" };
    const profiles = await this.profiles.find({
      $or: [{ username: regex }, { name: regex }],
    }).toArray();

    return [{ profiles }];
  }
}
