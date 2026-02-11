import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

/**
 * @concept Identifying
 * @purpose To assign global permissions levels or job functions to users.
 */
export type User = ID;

const PREFIX = "Identifying" + ".";

interface IdentityState {
  _id: User; // User ID as the primary key ensures singleton per user
  role: string;
}

export default class IdentifyingConcept {
  private readonly identities: Collection<IdentityState>;

  constructor(private readonly db: Db) {
    this.identities = this.db.collection<IdentityState>(PREFIX + "identities");
  }

  /**
   * Action: setRole (user: User, role: String) : (ok: Flag)
   */
  async setRole(
    { user, role }: { user: User; role: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!role || role.trim().length === 0) {
      return { error: "Role cannot be empty" };
    }

    await this.identities.updateOne(
      { _id: user },
      { $set: { role: role.trim() } },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * Action: removeRole (user: User) : (ok: Flag)
   */
  async removeRole(
    { user }: { user: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.identities.deleteOne({ _id: user });
    if (res.deletedCount === 0) {
      return { error: "User has no role to remove" };
    }
    return { ok: true };
  }

  /**
   * Query: _getRole (user: User) : (role: String | null)
   */
  async _getRole(
    { user }: { user: User },
  ): Promise<Array<{ role: string | null }>> {
    const doc = await this.identities.findOne({ _id: user });
    return [{ role: doc?.role ?? null }];
  }

  /**
   * Query: _hasRole (user: User, role: String) : (hasRole: Flag)
   */
  async _hasRole(
    { user, role }: { user: User; role: string },
  ): Promise<Array<{ hasRole: boolean }>> {
    const doc = await this.identities.findOne({ _id: user });
    return [{ hasRole: doc?.role === role }];
  }
}
