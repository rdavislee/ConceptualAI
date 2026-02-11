import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Tagging [Item, Owner]
export type Item = ID;
export type Owner = ID;

const PREFIX = "Tagging" + ".";

// State: Tags with optional owner
interface TagState {
  _id: string; // Composite: owner:tagname or just tagname for global
  name: string;
  owner?: Owner;
  items: Item[];
}

// State: Items with their tags
interface ItemTagsState {
  _id: Item; // item ID
  tags: string[]; // Array of tag IDs (composite keys)
}

/**
 * @concept Tagging
 * @purpose Allows items to be categorized or labeled with keywords (tags) for easier discovery and organization.
 * @principle An item can have multiple tags; the same tag can be applied to many items. Tags can optionally have an owner.
 */
export default class TaggingConcept {
  tags: Collection<TagState>;
  itemTags: Collection<ItemTagsState>;

  constructor(private readonly db: Db) {
    this.tags = this.db.collection<TagState>(PREFIX + "tags");
    this.itemTags = this.db.collection<ItemTagsState>(PREFIX + "itemTags");
  }

  private getTagId(name: string, owner?: Owner): string {
    return owner ? `${owner}:${name}` : name;
  }

  async ensureIndexes(): Promise<void> {
    await this.tags.createIndex({ owner: 1 });
    await this.itemTags.createIndex({ tags: 1 });
  }

  /**
   * Cleanup: deleteByOwner (owner) - removes all tags owned by user (e.g. account deletion).
   */
  async deleteByOwner({ owner }: { owner: Owner }): Promise<{ ok: boolean }> {
    const tagDocs = await this.tags.find({ owner }).toArray();
    const tagIds = tagDocs.map((t) => t._id);
    for (const tag of tagDocs) {
      for (const item of tag.items) {
        await this.itemTags.updateOne(
          { _id: item },
          { $pull: { tags: tag._id } },
        );
      }
    }
    await this.tags.deleteMany({ owner });
    return { ok: true };
  }

  /**
   * Cleanup: deleteByItem (item) - removes all tag assignments for item (e.g. item deletion).
   */
  async deleteByItem({ item }: { item: Item }): Promise<{ ok: boolean }> {
    return this.removeAllTags({ item }) as Promise<{ ok: boolean }>;
  }

  /**
   * Action: addTag (item: itemID, tag: String, owner?: Owner) : (ok: Flag)
   */
  async addTag(
    { item, tag, owner }: { item: Item; tag: string; owner?: Owner },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!tag.trim()) {
      return { error: "Tag cannot be empty" };
    }

    const tagId = this.getTagId(tag, owner);

    const existing = await this.itemTags.findOne(
      { _id: item, tags: tagId },
      { projection: { _id: 1 } },
    );
    if (existing) {
      return { error: "Item already has this tag" };
    }

    // Create/update tag and add item
    await this.tags.updateOne(
      { _id: tagId },
      {
        $set: { name: tag, owner },
        $addToSet: { items: item },
      },
      { upsert: true },
    );

    // Add tag to item
    await this.itemTags.updateOne(
      { _id: item },
      { $addToSet: { tags: tagId } },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * Action: removeTag (item: itemID, tag: String, owner?: Owner) : (ok: Flag)
   */
  async removeTag(
    { item, tag, owner }: { item: Item; tag: string; owner?: Owner },
  ): Promise<{ ok: boolean } | { error: string }> {
    const tagId = this.getTagId(tag, owner);

    const existing = await this.itemTags.findOne(
      { _id: item, tags: tagId },
      { projection: { _id: 1 } },
    );
    if (!existing) {
      return { error: "Item does not have this tag" };
    }

    // Remove from both
    await Promise.all([
      this.itemTags.updateOne(
        { _id: item },
        { $pull: { tags: tagId } },
      ),
      this.tags.updateOne(
        { _id: tagId },
        { $pull: { items: item } },
      ),
    ]);

    return { ok: true };
  }

  /**
   * Action: removeAllTags (item: itemID) : (ok: Flag)
   */
  async removeAllTags(
    { item }: { item: Item },
  ): Promise<{ ok: boolean }> {
    const itemDoc = await this.itemTags.findOne({ _id: item });
    if (itemDoc && itemDoc.tags.length > 0) {
      // Remove item from all tags
      await this.tags.updateMany(
        { _id: { $in: itemDoc.tags } },
        { $pull: { items: item } },
      );
      // Remove all tags from item
      await this.itemTags.deleteOne({ _id: item });
    }
    return { ok: true };
  }

  /**
   * Query: _getTags(item: itemID) : (tags: Set<{name: String, owner?: Owner}>)
   */
  async _getTags(
    { item }: { item: Item },
  ): Promise<Array<{ tags: Array<{ name: string; owner?: Owner }> }>> {
    const itemDoc = await this.itemTags.findOne({ _id: item });
    if (!itemDoc || itemDoc.tags.length === 0) {
      return [{ tags: [] }];
    }

    const tagDocs = await this.tags.find({ _id: { $in: itemDoc.tags } }).toArray();
    const tags = tagDocs.map((t: TagState) => ({
      name: t.name,
      owner: t.owner ?? undefined // Normalize null to undefined
    }));
    return [{ tags }];
  }

  /**
   * Query: _getItemsWithTag(tag: String, owner?: Owner) : (items: Set<itemID>)
   */
  async _getItemsWithTag(
    { tag, owner }: { tag: string; owner?: Owner },
  ): Promise<Array<{ items: Item[] }>> {
    const tagId = this.getTagId(tag, owner);
    const tagDoc = await this.tags.findOne({ _id: tagId });
    return [{ items: tagDoc?.items ?? [] }];
  }

  /**
   * Query: _getTagsByOwner(owner: Owner) : (tags: Set<{name: String, id: ID}>)
   */
  async _getTagsByOwner(
    { owner }: { owner: Owner },
  ): Promise<Array<{ tags: Array<{ name: string; id: string }> }>> {
    const tagDocs = await this.tags.find({ owner }).toArray();
    const tags = tagDocs.map((t: TagState) => ({ name: t.name, id: t._id }));
    return [{ tags }];
  }
}
