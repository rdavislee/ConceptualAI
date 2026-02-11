import { Collection, Db, Filter, Sort } from "npm:mongodb";
import { freshID } from "@utils/database.ts";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Paginating [Scope, Item]
export type List = ID;
export type Item = ID;
export type ScopeID = ID;
export type ScopeType = string;
export type SortMode = "createdAt" | "score";

const PREFIX = "Paginating" + ".";
const SORT_MODES: SortMode[] = ["createdAt", "score"];

interface PaginationListState {
  _id: List;
  scopeType: ScopeType;
  scopeID?: ScopeID;
  itemType: string; // e.g. "post", "comment"
  mode: SortMode;
  pageSize: number;
  createdAt: Date;
  updatedAt: Date;
}

interface PaginationEntryState {
  _id: string; // list:item
  list: List;
  item: Item;
  createdAt: Date; // tie-breaker field, always present
  score: number; // generic ranking signal (likes, comments, etc.)
  updatedAt: Date;
}

/**
 * @concept Paginating
 * @purpose Maintain reusable, paged item lists with configurable sorting modes.
 * @principle Syncs add/remove/update item ranking data in this concept, and consumers fetch stable pages of item IDs.
 */
export default class PaginatingConcept {
  lists: Collection<PaginationListState>;
  entries: Collection<PaginationEntryState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.lists = this.db.collection<PaginationListState>(PREFIX + "lists");
    this.entries = this.db.collection<PaginationEntryState>(PREFIX + "entries");
  }

  private getEntryId(list: List, item: Item): string {
    return `${list}:${item}`;
  }

  private isValidPageSize(pageSize: number): boolean {
    return Number.isInteger(pageSize) && pageSize > 0;
  }

  private isValidMode(mode: string): mode is SortMode {
    return SORT_MODES.includes(mode as SortMode);
  }

  private validateScope(
    { scopeType, scopeID }: { scopeType: ScopeType; scopeID?: ScopeID },
  ): string | null {
    const normalizedScopeType = scopeType.trim();
    if (normalizedScopeType.length === 0) {
      return "scopeType must be a non-empty string";
    }

    const isSystemScope = normalizedScopeType.toLowerCase() === "system";
    if (isSystemScope) {
      if (scopeID !== undefined) {
        return "scopeID must be omitted for system scope";
      }
      return null;
    }

    if (scopeID === undefined) {
      return "scopeID is required unless scopeType is system";
    }
    return null;
  }

  private buildScopeFilter(
    { scopeType, scopeID }: { scopeType: ScopeType; scopeID?: ScopeID },
  ): Filter<PaginationListState> {
    const normalizedScopeType = scopeType.trim();
    const isSystemScope = normalizedScopeType.toLowerCase() === "system";
    if (isSystemScope) {
      return { scopeType: "system", scopeID: { $exists: false } };
    }
    return { scopeType: normalizedScopeType, scopeID: scopeID as ScopeID };
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.lists.createIndex({ scopeType: 1, scopeID: 1, itemType: 1 }),
      this.lists.createIndex({ itemType: 1 }),
      this.entries.createIndex({ list: 1, createdAt: -1, item: 1 }),
      this.entries.createIndex({ list: 1, score: -1, createdAt: -1, item: 1 }),
      this.entries.createIndex({ item: 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: createList (scopeType: String, scopeID?: scopeID, itemType: String, pageSize: Number, mode?: String) : (list: List)
   */
  async createList(
    { scopeType, scopeID, itemType, pageSize, mode }: {
      scopeType: ScopeType;
      scopeID?: ScopeID;
      itemType: string;
      pageSize: number;
      mode?: SortMode;
    },
  ): Promise<{ list: List } | { error: string }> {
    await this.ensureIndexes();
    if (!this.isValidPageSize(pageSize)) {
      return { error: "pageSize must be a positive integer" };
    }
    if (!itemType || itemType.trim().length === 0) {
      return { error: "itemType must be a non-empty string" };
    }

    const scopeError = this.validateScope({ scopeType, scopeID });
    if (scopeError) {
      return { error: scopeError };
    }
    const normalizedScopeType = scopeType.trim();
    const isSystemScope = normalizedScopeType.toLowerCase() === "system";

    const resolvedMode = mode ?? "createdAt";
    if (!this.isValidMode(resolvedMode)) {
      return { error: "Invalid mode. Must be one of: createdAt, score" };
    }

    const list = freshID() as List;
    const now = new Date();
    const doc: PaginationListState = {
      _id: list,
      scopeType: isSystemScope ? "system" : normalizedScopeType,
      itemType: itemType.trim(),
      mode: resolvedMode,
      pageSize,
      createdAt: now,
      updatedAt: now,
    };
    if (!isSystemScope) {
      doc.scopeID = scopeID as ScopeID;
    }

    await this.lists.insertOne(doc);
    return { list };
  }

  /**
   * Action: setMode (list: List, mode: String) : (ok: Flag)
   */
  async setMode(
    { list, mode }: { list: List; mode: SortMode },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    if (!this.isValidMode(mode)) {
      return { error: "Invalid mode. Must be one of: createdAt, score" };
    }

    const res = await this.lists.updateOne(
      { _id: list },
      { $set: { mode, updatedAt: new Date() } },
    );
    if (res.matchedCount === 0) {
      return { error: "List not found" };
    }
    return { ok: true };
  }

  /**
   * Action: setPageSize (list: List, pageSize: Number) : (ok: Flag)
   */
  async setPageSize(
    { list, pageSize }: { list: List; pageSize: number },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    if (!this.isValidPageSize(pageSize)) {
      return { error: "pageSize must be a positive integer" };
    }

    const res = await this.lists.updateOne(
      { _id: list },
      { $set: { pageSize, updatedAt: new Date() } },
    );
    if (res.matchedCount === 0) {
      return { error: "List not found" };
    }
    return { ok: true };
  }

  /**
   * Action: upsertEntry (list: List, item: Item, createdAt: DateTime, score?: Number) : (ok: Flag)
   */
  async upsertEntry(
    { list, item, createdAt, score }: {
      list: List;
      item: Item;
      createdAt: Date;
      score?: number;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    if (!(createdAt instanceof Date) || isNaN(createdAt.getTime())) {
      return { error: "createdAt must be a valid Date" };
    }

    const resolvedScore = score ?? 0;
    if (!Number.isFinite(resolvedScore)) {
      return { error: "score must be a finite number" };
    }

    const listDoc = await this.lists.findOne({ _id: list });
    if (!listDoc) {
      return { error: "List not found" };
    }

    const entryId = this.getEntryId(list, item);
    await this.entries.updateOne(
      { _id: entryId },
      {
        $set: {
          list,
          item,
          createdAt,
          score: resolvedScore,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return { ok: true };
  }

  /**
   * Action: setEntryScore (list: List, item: Item, score: Number) : (ok: Flag)
   */
  async setEntryScore(
    { list, item, score }: { list: List; item: Item; score: number },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    if (!Number.isFinite(score)) {
      return { error: "score must be a finite number" };
    }

    const entryId = this.getEntryId(list, item);
    const res = await this.entries.updateOne(
      { _id: entryId },
      { $set: { score, updatedAt: new Date() } },
    );
    if (res.matchedCount === 0) {
      return { error: "Entry not found" };
    }
    return { ok: true };
  }

  /**
   * Action: removeEntry (list: List, item: Item) : (ok: Flag)
   */
  async removeEntry(
    { list, item }: { list: List; item: Item },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    const entryId = this.getEntryId(list, item);
    const res = await this.entries.deleteOne({ _id: entryId });
    if (res.deletedCount === 0) {
      return { error: "Entry not found" };
    }
    return { ok: true };
  }

  /**
   * Action: deleteList (list: List) : (ok: Flag)
   */
  async deleteList(
    { list }: { list: List },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    const listRes = await this.lists.deleteOne({ _id: list });
    if (listRes.deletedCount === 0) {
      return { error: "List not found" };
    }

    await this.entries.deleteMany({ list });
    return { ok: true };
  }

  /**
   * Action: deleteByScope (scopeType: String, scopeID?: scopeID) : (ok: Flag)
   */
  async deleteByScope(
    { scopeType, scopeID }: { scopeType: ScopeType; scopeID?: ScopeID },
  ): Promise<{ ok: boolean; listsRemoved: number; entriesRemoved: number } | { error: string }> {
    await this.ensureIndexes();
    const scopeError = this.validateScope({ scopeType, scopeID });
    if (scopeError) {
      return { error: scopeError };
    }

    const filter = this.buildScopeFilter({ scopeType, scopeID });
    const listDocs = await this.lists.find(filter, { projection: { _id: 1 } }).toArray();

    if (listDocs.length === 0) {
      return { ok: true, listsRemoved: 0, entriesRemoved: 0 };
    }

    const listIds = listDocs.map((doc) => doc._id);
    const [entriesRes, listsRes] = await Promise.all([
      this.entries.deleteMany({ list: { $in: listIds } }),
      this.lists.deleteMany({ _id: { $in: listIds } }),
    ]);

    return {
      ok: true,
      listsRemoved: listsRes.deletedCount,
      entriesRemoved: entriesRes.deletedCount,
    };
  }

  /**
   * Action: deleteByItem (item: Item) : (ok: Flag)
   */
  async deleteByItem(
    { item }: { item: Item },
  ): Promise<{ ok: boolean; removed: number }> {
    await this.ensureIndexes();
    const res = await this.entries.deleteMany({ item });
    return { ok: true, removed: res.deletedCount };
  }

  /**
   * Query: _getPage (list: List, page: Number) : (items: Set<Item>, mode: String, pageSize: Number, totalItems: Number, totalPages: Number)
   */
  async _getPage(
    { list, page }: { list: List; page: number },
  ): Promise<
    Array<
      | {
        page: number;
        pageSize: number;
        totalItems: number;
        totalPages: number;
        mode: SortMode;
        scopeType: ScopeType;
        scopeID?: ScopeID;
        itemType: string;
        items: Item[];
      }
      | { error: string }
    >
  > {
    await this.ensureIndexes();
    if (!Number.isInteger(page) || page <= 0) {
      return [{ error: "page must be a positive integer" }];
    }

    const listDoc = await this.lists.findOne({ _id: list });
    if (!listDoc) {
      return [{ error: "List not found" }];
    }

    const totalItems = await this.entries.countDocuments({ list });
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / listDoc.pageSize);
    const skip = (page - 1) * listDoc.pageSize;

    const sort: Sort = listDoc.mode === "score"
      ? { score: -1, createdAt: -1, item: 1 }
      : { createdAt: -1, item: 1 };

    const docs = await this.entries.find(
      { list },
      { projection: { item: 1 } },
    ).sort(sort).skip(skip).limit(listDoc.pageSize).toArray();

    return [{
      page,
      pageSize: listDoc.pageSize,
      totalItems,
      totalPages,
      mode: listDoc.mode,
      scopeType: listDoc.scopeType,
      scopeID: listDoc.scopeID,
      itemType: listDoc.itemType,
      items: docs.map((d) => d.item),
    }];
  }

  /**
   * Query: _getList (list: List) : (list: PaginationList | null)
   */
  async _getList(
    { list }: { list: List },
  ): Promise<Array<{ list: PaginationListState | null }>> {
    await this.ensureIndexes();
    const listDoc = await this.lists.findOne({ _id: list });
    return [{ list: listDoc }];
  }

  /**
   * Query: _getListsByScope (scopeType: String, scopeID?: scopeID, itemType?: String) : (lists: Set<List>)
   */
  async _getListsByScope(
    { scopeType, scopeID, itemType }: { scopeType: ScopeType; scopeID?: ScopeID; itemType?: string },
  ): Promise<Array<{ lists: List[] } | { error: string }>> {
    await this.ensureIndexes();
    const scopeError = this.validateScope({ scopeType, scopeID });
    if (scopeError) {
      return [{ error: scopeError }];
    }

    const filter: Filter<PaginationListState> = this.buildScopeFilter({
      scopeType,
      scopeID,
    });
    if (itemType !== undefined) {
      filter.itemType = itemType;
    }

    const docs = await this.lists.find(filter, { projection: { _id: 1 } }).toArray();
    return [{ lists: docs.map((d) => d._id) }];
  }

  /**
   * Query: _hasEntry (list: List, item: Item) : (hasEntry: Flag)
   */
  async _hasEntry(
    { list, item }: { list: List; item: Item },
  ): Promise<Array<{ hasEntry: boolean }>> {
    await this.ensureIndexes();
    const entryId = this.getEntryId(list, item);
    const doc = await this.entries.findOne(
      { _id: entryId },
      { projection: { _id: 1 } },
    );
    return [{ hasEntry: !!doc }];
  }
}
