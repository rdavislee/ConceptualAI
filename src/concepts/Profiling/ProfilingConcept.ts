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

  constructor(private readonly db: Db) {
    this.profiles = this.db.collection<ProfileState>(PREFIX + "profiles");
  }

  /**
   * Action: createProfile (user: User, name: String, bio: String, bioImageUrl: String) : (ok: Flag)
   * requires: profile for user does not already exist
   * effects: create profile for user with name, bio, bioImageUrl, createdAt := now, updatedAt := now
   */
  async createProfile(
    { user, username, name, bio, bioImageUrl }: {
      user: User;
      username: string;
      name: string;
      bio: string;
      bioImageUrl: string;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    const existing = await this.profiles.findOne({ _id: user });
    if (existing) {
      return { error: "Profile already exists" };
    }

    const usernameExists = await this.profiles.findOne({ username });
    if (usernameExists) {
      return { error: "Username already taken" };
    }

    const now = new Date();
    await this.profiles.insertOne({
      _id: user,
      username,
      name,
      bio,
      bioImageUrl,
      createdAt: now,
      updatedAt: now,
    });

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

    const result = await this.profiles.updateOne(
      { _id: user },
      update,
      { upsert: false },
    );

    if (result.matchedCount === 0) {
      return { error: "Profile does not exist" };
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
    const usernameExists = await this.profiles.findOne({ username: newUsername, _id: { $ne: user } });
    if (usernameExists) {
      return { error: "Username already taken" };
    }

    const now = new Date();
    const result = await this.profiles.updateOne(
      { _id: user },
      { $set: { username: newUsername, updatedAt: now } },
    );

    if (result.matchedCount === 0) {
      return { error: "Profile does not exist" };
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
}
