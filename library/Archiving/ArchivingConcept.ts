import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Archiving [Target]
export type Target = ID;

const PREFIX = "Archiving" + ".";

interface ArchiveState {
  _id: Target; // target ID
  archivedAt: Date;
}

/**
 * @concept Archiving
 * @purpose Provide a generic way to move items to an "archived" or "inactive" state.
 */
export default class ArchivingConcept {
  archivedItems: Collection<ArchiveState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.archivedItems = this.db.collection<ArchiveState>(PREFIX + "archivedItems");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.archivedItems.createIndex({ archivedAt: -1 });
    this.indexesCreated = true;
  }

  /**
   * Action: archive (target: Target) : (ok: Flag)
   */
  async archive(
    { target }: { target: Target },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    try {
      await this.archivedItems.insertOne({
        _id: target,
        archivedAt: new Date(),
      });
      return { ok: true };
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code === 11000) {
        return { error: "Target is already archived" };
      }
      throw e;
    }
  }

  /**
   * Lifecycle: deleteByTarget (target: Target) : (ok: Flag)
   * Hard-deletes the archived record when the target is removed. Use for target deletion flows.
   */
  async deleteByTarget({ target }: { target: Target }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.archivedItems.deleteOne({ _id: target });
    return { ok: true };
  }

  /**
   * Action: unarchive (target: Target) : (ok: Flag)
   */
  async unarchive(
    { target }: { target: Target },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.archivedItems.deleteOne({ _id: target });
    if (res.deletedCount === 0) {
      return { error: "Target is not archived" };
    }
    return { ok: true };
  }

  /**
   * Query: _isArchived (target: Target) : (archived: Flag)
   */
  async _isArchived(
    { target }: { target: Target },
  ): Promise<Array<{ archived: boolean }>> {
    const archive = await this.archivedItems.findOne({ _id: target });
    return [{ archived: !!archive }];
  }

  /**
   * Query: _allArchived () : (targets: Set<Target>)
   */
  async _allArchived(): Promise<Array<{ targets: Target[] }>> {
    await this.ensureIndexes();
    const archived = await this.archivedItems.find().sort({ archivedAt: -1 }).toArray();
    return [{ targets: archived.map((a: ArchiveState) => a._id as Target) }];
  }
}
