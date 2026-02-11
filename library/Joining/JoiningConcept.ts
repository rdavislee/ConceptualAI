import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Joining [Member, Target]
export type Member = ID;
export type Target = ID;

const PREFIX = "Joining" + ".";

interface MembershipState {
  _id: string; // member:target
  member: Member;
  target: Target;
  joinedAt: Date;
}

/**
 * @concept Joining
 * @purpose Manage many-to-many associations between members and targets, such as users joining a group or subscribing to a list.
 * @principle If a member joins a target, they are added to the target's membership set; if they later leave, they are removed.
 */
export default class JoiningConcept {
  memberships: Collection<MembershipState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.memberships = this.db.collection<MembershipState>(PREFIX + "memberships");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.memberships.createIndex({ member: 1 });
    await this.memberships.createIndex({ target: 1 });
    this.indexesCreated = true;
  }

  /**
   * Lifecycle: deleteByMember (member: Member) : (ok: Flag)
   * Removes all memberships for the given member. Use when member account is deleted.
   */
  async deleteByMember({ member }: { member: Member }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.memberships.deleteMany({ member });
    return { ok: true };
  }

  /**
   * Lifecycle: deleteByTarget (target: Target) : (ok: Flag)
   * Removes all memberships for the given target. Use when target (e.g. group) is deleted.
   */
  async deleteByTarget({ target }: { target: Target }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.memberships.deleteMany({ target });
    return { ok: true };
  }

  /**
   * Action: join (member: Member, target: Target) : (ok: Flag)
   * Uses insertOne + catch duplicate key on _id for atomic join (avoids check-then-insert race).
   */
  async join(
    { member, target }: { member: Member; target: Target },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    const _id = `${member}:${target}`;
    try {
      await this.memberships.insertOne({
        _id,
        member,
        target,
        joinedAt: new Date(),
      });
      return { ok: true };
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && (e as { code: number }).code === 11000) {
        return { error: "Member is already a member" };
      }
      throw e;
    }
  }

  /**
   * Action: leave (member: Member, target: Target) : (ok: Flag)
   */
  async leave(
    { member, target }: { member: Member; target: Target },
  ): Promise<{ ok: boolean } | { error: string }> {
    const _id = `${member}:${target}`;
    const res = await this.memberships.deleteOne({ _id });
    if (res.deletedCount === 0) {
      return { error: "Member is not a member" };
    }
    return { ok: true };
  }

  /**
   * Query: _getMembers (target: Target) : (members: Set<Member>)
   */
  async _getMembers(
    { target }: { target: Target },
  ): Promise<Array<{ members: Member[] }>> {
    const memberships = await this.memberships.find({ target }).toArray();
    return [{ members: memberships.map((m: MembershipState) => m.member) }];
  }

  /**
   * Query: _getMemberships (member: Member) : (targets: Set<Target>)
   */
  async _getMemberships(
    { member }: { member: Member },
  ): Promise<Array<{ targets: Target[] }>> {
    const memberships = await this.memberships.find({ member }).toArray();
    return [{ targets: memberships.map((m: MembershipState) => m.target as Target) }];
  }

  /**
   * Query: _isMember (member: Member, target: Target) : (member: Flag)
   */
  async _isMember(
    { member, target }: { member: Member; target: Target },
  ): Promise<Array<{ member: boolean }>> {
    const _id = `${member}:${target}`;
    const membership = await this.memberships.findOne({ _id });
    return [{ member: !!membership }];
  }
}
