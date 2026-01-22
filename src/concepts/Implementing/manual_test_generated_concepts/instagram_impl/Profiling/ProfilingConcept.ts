import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Profiling [User]
export type User = ID;

const PREFIX = "Profiling" + ".";

// State: a set of Profiles with a user ID, a name...
interface ProfileState {
  _id: User; // user ID
  name: string;
  bio: string;
  bioImageUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept Profiling
 * @purpose Allows users to present a public identity and additional information about themselves to others.
 * @principle Each user has at most one profile; the user is the only one who can update their profile.
 * @state
 *  a set of Profiles with a user ID, a name String, a bio String, a bioImageUrl String, a createdAt DateTime, an updatedAt DateTime
 */
export default class ProfilingConcept {
  profiles: Collection<ProfileState>;

  constructor(private readonly db: Db) {
    this.profiles = this.db.collection<ProfileState>(PREFIX + "profiles");
  }

  /**
   * Action: updateProfile (user: userID, name?: String, bio?: String, bioImageUrl?: String) : (ok: Flag)
   * requires: user exists, at least one field provided
   * effects: create or update profile with fields and updatedAt := now
   */
  async updateProfile(
    { user, name, bio, bioImageUrl }: {
      user: User;
      name?: string;
      bio?: string;
      bioImageUrl?: string;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (name === undefined && bio === undefined && bioImageUrl === undefined) {
      return { error: "No fields provided for update" };
    }

    const now = new Date();
    const update: any = { $set: { updatedAt: now } };
    const setOnInsert: any = { createdAt: now };

    if (name !== undefined) update.$set.name = name;
    if (bio !== undefined) update.$set.bio = bio;
    if (bioImageUrl !== undefined) update.$set.bioImageUrl = bioImageUrl;

    await this.profiles.updateOne(
      { _id: user },
      { ...update, $setOnInsert: setOnInsert },
      { upsert: true },
    );

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
}
