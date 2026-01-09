import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Collection prefix to ensure namespace separation
const PREFIX = "UserProfileDisplaying" + ".";

// Generic type for the concept's external dependency
type User = ID;

/**
 * State: A set of Profiles with
 *   a user Users
 *   an optional username String
 *   an optional displayName String
 *   an optional avatarUrl String
 *   an optional bio String
 */
interface ProfileDoc {
  _id: User; // Use user ID as the document ID for easy lookup
  user: User; // Reference to the user (matches spec: "a set of Profiles with a user Users")
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
}

/**
 * @concept UserProfileDisplaying
 * @purpose Present human-readable identity attributes for users (display name, avatar, bio), independent of authentication or activity.
 * @principle A user sets profile fields; others read them for display; edits update fields without affecting other concerns.
 */
export default class UserProfileDisplayingConcept {
  profiles: Collection<ProfileDoc>;

  constructor(private readonly db: Db) {
    this.profiles = this.db.collection<ProfileDoc>(PREFIX + "profiles");
  }

  /**
   * Action: setProfile (user: Users, username: String, displayName: String, avatarUrl: String, bio: String) : (ok: Flag)
   * requires: user exists
   * effects: set only the provided fields, leaving others unchanged
   */
  async setProfile(
    {
      user,
      username,
      displayName,
      avatarUrl,
      bio,
    }: {
      user: User;
      username?: string;
      displayName?: string;
      avatarUrl?: string;
      bio?: string;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!user) {
      return { error: "User ID is required" };
    }

    // Build update object with only provided fields
    const updateFields: Partial<ProfileDoc> = { user };
    if (username !== undefined) {
      updateFields.username = username.trim() || undefined;
    }
    if (displayName !== undefined) {
      updateFields.displayName = displayName.trim() || undefined;
    }
    if (avatarUrl !== undefined) {
      updateFields.avatarUrl = avatarUrl.trim() || undefined;
    }
    if (bio !== undefined) {
      updateFields.bio = bio.trim() || undefined;
    }

    await this.profiles.updateOne(
      { _id: user },
      { $set: updateFields },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * Query: _profileOf(user: Users) : (username: String, displayName: String, avatarUrl: String, bio: String)
   * requires: user exists
   * effects: returns the profile fields for the user
   */
  async _profileOf(
    { user }: { user: User },
  ): Promise<
    Array<
      { username: string; displayName: string; avatarUrl: string; bio: string }
    >
  > {
    const profile = await this.profiles.findOne({ _id: user });

    if (!profile) {
      // Return empty strings for all fields if profile doesn't exist
      return [{ username: "", displayName: "", avatarUrl: "", bio: "" }];
    }

    return [{
      username: profile.username || "",
      displayName: profile.displayName || "",
      avatarUrl: profile.avatarUrl || "",
      bio: profile.bio || "",
    }];
  }

  /**
   * Query: _userByUsername(username: String) : (user: User) | (error: String)
   * requires: true
   * effects: returns the user associated with the given username if it exists, otherwise returns an error
   */
  async _userByUsername(
    { username }: { username: string },
  ): Promise<Array<{ user: User }> | [{ error: string }]> {
    if (!username || !username.trim()) {
      return [{ error: "Username is required" }];
    }

    const profile = await this.profiles.findOne({ username: username.trim() });

    if (!profile) {
      return [{ error: "Username not found" }];
    }

    return [{ user: profile.user }];
  }
}
