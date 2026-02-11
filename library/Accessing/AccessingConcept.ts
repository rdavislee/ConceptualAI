import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Accessing [Subject, Target]
export type Subject = ID;
export type Target = ID;

const PREFIX = "Accessing" + ".";

const ROLES = ["viewer", "editor", "owner"] as const;
type Role = typeof ROLES[number];

const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

interface AccessRuleState {
  _id: string; // subject:target
  subject: Subject;
  target: Target;
  role: Role;
}

/**
 * @concept Accessing
 * @purpose Control access permissions for targets, defining who can view, edit, or manage them.
 * @principle A subject is granted a specific role (e.g., viewer, editor, owner) on a target; any subsequent check for that subject's access level returns their assigned role, or none if no access was granted.
 */
export default class AccessingConcept {
  accessRules: Collection<AccessRuleState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.accessRules = this.db.collection<AccessRuleState>(PREFIX + "accessRules");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.accessRules.createIndex({ subject: 1 });
    await this.accessRules.createIndex({ target: 1 });
    await this.accessRules.createIndex({ subject: 1, target: 1 });
    this.indexesCreated = true;
  }

  /**
   * Action: grantAccess (subject: Subject, target: Target, role: String) : (ok: Flag)
   */
  async grantAccess(
    { subject, target, role }: { subject: Subject; target: Target; role: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!ROLES.includes(role as Role)) {
      return { error: `Invalid role: ${role}. Must be one of ${ROLES.join(", ")}` };
    }

    await this.ensureIndexes();
    const _id = `${subject}:${target}`;
    await this.accessRules.updateOne(
      { _id },
      { $set: { subject, target, role: role as Role } },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * Lifecycle: deleteBySubject (subject: Subject) : (ok: Flag)
   * Deletes all access rules for the given subject. Use when subject (e.g. user) is deleted.
   */
  async deleteBySubject({ subject }: { subject: Subject }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.accessRules.deleteMany({ subject });
    return { ok: true };
  }

  /**
   * Lifecycle: deleteByTarget (target: Target) : (ok: Flag)
   * Deletes all access rules for the given target. Use when target (e.g. item) is deleted.
   */
  async deleteByTarget({ target }: { target: Target }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.accessRules.deleteMany({ target });
    return { ok: true };
  }

  /**
   * Action: revokeAccess (subject: Subject, target: Target) : (ok: Flag)
   */
  async revokeAccess(
    { subject, target }: { subject: Subject; target: Target },
  ): Promise<{ ok: boolean } | { error: string }> {
    const _id = `${subject}:${target}`;
    const res = await this.accessRules.deleteOne({ _id });
    if (res.deletedCount === 0) {
      return { error: "No access rule found for this subject and target" };
    }
    return { ok: true };
  }

  /**
   * Query: _getAccess (subject: Subject, target: Target) : (role: String | null)
   */
  async _getAccess(
    { subject, target }: { subject: Subject; target: Target },
  ): Promise<Array<{ role: string | null }>> {
    const _id = `${subject}:${target}`;
    const rule = await this.accessRules.findOne({ _id });
    return [{ role: rule ? rule.role : null }];
  }

  /**
   * Query: _hasAccess (subject: Subject, target: Target, requiredRole: String) : (hasAccess: Flag)
   */
  async _hasAccess(
    { subject, target, requiredRole }: { subject: Subject; target: Target; requiredRole: string },
  ): Promise<Array<{ hasAccess: boolean }>> {
    if (!ROLES.includes(requiredRole as Role)) {
      return [{ hasAccess: false }];
    }

    const _id = `${subject}:${target}`;
    const rule = await this.accessRules.findOne({ _id });
    if (!rule) return [{ hasAccess: false }];

    const hasAccess = ROLE_RANK[rule.role as Role] >= ROLE_RANK[requiredRole as Role];
    return [{ hasAccess }];
  }
}
