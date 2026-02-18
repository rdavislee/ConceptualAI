import { Collection, Db, Filter, Sort } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Paginating [Bound, Item]
export type Item = ID;
export type Bound = ID | "common";
export type SortMode = "createdAt" | "score";

const PREFIX = "Paginating" + ".";
const SORT_MODES: SortMode[] = ["createdAt", "score"];
const DEFAULT_BOUND: Bound = "common";
const DEFAULT_MODE: SortMode = "createdAt";
const DEFAULT_PAGE_SIZE = 20;

interface PaginationListState {
  _id: string; // JSON tuple [bound,itemType]
  bound: Bound;
  itemType: string; // e.g. "posts", "comments"
  mode: SortMode;
  createdAt: Date;
  updatedAt: Date;
}

interface PaginationEntryState {
  _id: string; // JSON tuple [bound,itemType,item]
  bound: Bound;
  itemType: string;
  item: Item;
  createdAt: Date; // tie-breaker field, always present
  score: number; // generic ranking signal (likes, comments, etc.)
  updatedAt: Date;
}

interface ListRef {
  bound: Bound;
  itemType: string;
}

/**
 * @concept Paginating
 * @purpose Maintain reusable, paged item lists with configurable sorting modes.
 * @principle Syncs upsert list entries directly by (bound,itemType), and consumers fetch stable pages of item IDs.
 */
export default class PaginatingConcept {
  lists: Collection<PaginationListState>;
  entries: Collection<PaginationEntryState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.lists = this.db.collection<PaginationListState>(PREFIX + "lists");
    this.entries = this.db.collection<PaginationEntryState>(PREFIX + "entries");
  }

  private normalizeBound(bound?: Bound): Bound {
    if (bound === undefined) {
      return DEFAULT_BOUND;
    }

    const normalized = bound.trim();
    if (normalized.length === 0) {
      return DEFAULT_BOUND;
    }
    return normalized as Bound;
  }

  private normalizeItemType(itemType: string): string | null {
    const normalized = itemType.trim();
    if (normalized.length === 0) {
      return null;
    }
    return normalized;
  }

  private isValidPageSize(pageSize: number): boolean {
    return Number.isInteger(pageSize) && pageSize > 0;
  }

  private isValidMode(mode: string): mode is SortMode {
    return SORT_MODES.includes(mode as SortMode);
  }

  private getListId({ bound, itemType }: ListRef): string {
    return JSON.stringify([bound, itemType]);
  }

  private getEntryId(
    { bound, itemType, item }: ListRef & { item: Item },
  ): string {
    return JSON.stringify([bound, itemType, item]);
  }

  private async ensureList(
    { bound, itemType, mode }: {
      bound: Bound;
      itemType: string;
      mode?: SortMode;
    },
  ): Promise<{ list: PaginationListState } | { error: string }> {
    if (mode !== undefined && !this.isValidMode(mode)) {
      return { error: "Invalid mode. Must be one of: createdAt, score" };
    }

    const listId = this.getListId({ bound, itemType });
    const now = new Date();
    await this.lists.updateOne(
      { _id: listId },
      {
        $setOnInsert: {
          _id: listId,
          bound,
          itemType,
          mode: mode ?? DEFAULT_MODE,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    const list = await this.lists.findOne({ _id: listId });
    if (!list) {
      return { error: "Failed to create or load list" };
    }
    return { list };
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.lists.createIndex({ bound: 1, itemType: 1 }),
      this.lists.createIndex({ itemType: 1 }),
      this.entries.createIndex({
        bound: 1,
        itemType: 1,
        createdAt: -1,
        item: 1,
      }),
      this.entries.createIndex({
        bound: 1,
        itemType: 1,
        score: -1,
        createdAt: -1,
        item: 1,
      }),
      this.entries.createIndex({ item: 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: setMode (bound?: Bound, itemType: String, mode: String) : (ok: Flag)
   */
  async setMode(
    { bound, itemType, mode }: {
      bound?: Bound;
      itemType: string;
      mode: SortMode;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();

    const normalizedItemType = this.normalizeItemType(itemType);
    if (!normalizedItemType) {
      return { error: "itemType must be a non-empty string" };
    }

    if (!this.isValidMode(mode)) {
      return { error: "Invalid mode. Must be one of: createdAt, score" };
    }

    const normalizedBound = this.normalizeBound(bound);
    const listId = this.getListId({
      bound: normalizedBound,
      itemType: normalizedItemType,
    });
    const now = new Date();

    await this.lists.updateOne(
      { _id: listId },
      {
        $set: {
          bound: normalizedBound,
          itemType: normalizedItemType,
          mode,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    return { ok: true };
  }

  /**
   * Action: upsertEntry (bound?: Bound, itemType: String, item: Item, createdAt: DateTime, score?: Number, mode?: String) : (ok: Flag)
   */
  async upsertEntry(
    { bound, itemType, item, createdAt, score, mode }: {
      bound?: Bound;
      itemType: string;
      item: Item;
      createdAt: Date;
      score?: number;
      mode?: SortMode;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();

    const normalizedItemType = this.normalizeItemType(itemType);
    if (!normalizedItemType) {
      return { error: "itemType must be a non-empty string" };
    }

    if (!(createdAt instanceof Date) || isNaN(createdAt.getTime())) {
      return { error: "createdAt must be a valid Date" };
    }

    const resolvedScore = score ?? 0;
    if (!Number.isFinite(resolvedScore)) {
      return { error: "score must be a finite number" };
    }

    const normalizedBound = this.normalizeBound(bound);
    const ensured = await this.ensureList({
      bound: normalizedBound,
      itemType: normalizedItemType,
      mode,
    });
    if ("error" in ensured) {
      return ensured;
    }

    const now = new Date();
    const entryId = this.getEntryId({
      bound: normalizedBound,
      itemType: normalizedItemType,
      item,
    });

    await this.entries.updateOne(
      { _id: entryId },
      {
        $set: {
          bound: normalizedBound,
          itemType: normalizedItemType,
          item,
          createdAt,
          score: resolvedScore,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    await this.lists.updateOne(
      { _id: ensured.list._id },
      { $set: { updatedAt: now } },
    );
    return { ok: true };
  }

  /**
   * Action: setEntryScore (bound?: Bound, itemType: String, item: Item, score: Number) : (ok: Flag)
   */
  async setEntryScore(
    { bound, itemType, item, score }: {
      bound?: Bound;
      itemType: string;
      item: Item;
      score: number;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();

    const normalizedItemType = this.normalizeItemType(itemType);
    if (!normalizedItemType) {
      return { error: "itemType must be a non-empty string" };
    }

    if (!Number.isFinite(score)) {
      return { error: "score must be a finite number" };
    }

    const normalizedBound = this.normalizeBound(bound);
    const entryId = this.getEntryId({
      bound: normalizedBound,
      itemType: normalizedItemType,
      item,
    });

    const now = new Date();
    const res = await this.entries.updateOne(
      { _id: entryId },
      { $set: { score, updatedAt: now } },
    );
    if (res.matchedCount === 0) {
      return { error: "Entry not found" };
    }

    await this.lists.updateOne(
      {
        _id: this.getListId({
          bound: normalizedBound,
          itemType: normalizedItemType,
        }),
      },
      { $set: { updatedAt: now } },
    );
    return { ok: true };
  }

  /**
   * Action: removeEntry (bound?: Bound, itemType: String, item: Item) : (ok: Flag)
   */
  async removeEntry(
    { bound, itemType, item }: { bound?: Bound; itemType: string; item: Item },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();

    const normalizedItemType = this.normalizeItemType(itemType);
    if (!normalizedItemType) {
      return { error: "itemType must be a non-empty string" };
    }

    const normalizedBound = this.normalizeBound(bound);
    const entryId = this.getEntryId({
      bound: normalizedBound,
      itemType: normalizedItemType,
      item,
    });
    const res = await this.entries.deleteOne({ _id: entryId });
    if (res.deletedCount === 0) {
      return { error: "Entry not found" };
    }

    await this.lists.updateOne(
      {
        _id: this.getListId({
          bound: normalizedBound,
          itemType: normalizedItemType,
        }),
      },
      { $set: { updatedAt: new Date() } },
    );
    return { ok: true };
  }

  /**
   * Action: deleteList (bound?: Bound, itemType: String) : (ok: Flag)
   */
  async deleteList(
    { bound, itemType }: { bound?: Bound; itemType: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    const normalizedItemType = this.normalizeItemType(itemType);
    if (!normalizedItemType) {
      return { error: "itemType must be a non-empty string" };
    }

    const normalizedBound = this.normalizeBound(bound);
    const listId = this.getListId({
      bound: normalizedBound,
      itemType: normalizedItemType,
    });
    const listRes = await this.lists.deleteOne({ _id: listId });
    if (listRes.deletedCount === 0) {
      return { error: "List not found" };
    }

    await this.entries.deleteMany({
      bound: normalizedBound,
      itemType: normalizedItemType,
    });
    return { ok: true };
  }

  /**
   * Action: deleteByBound (bound?: Bound) : (ok: Flag)
   */
  async deleteByBound(
    { bound }: { bound?: Bound },
  ): Promise<{ ok: boolean; listsRemoved: number; entriesRemoved: number }> {
    await this.ensureIndexes();
    const normalizedBound = this.normalizeBound(bound);

    const [entriesRes, listsRes] = await Promise.all([
      this.entries.deleteMany({ bound: normalizedBound }),
      this.lists.deleteMany({ bound: normalizedBound }),
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
   * Query: _getPage (bound?: Bound, itemType: String, page: Number, pageSize?: Number) : (items: List<Item>, mode: String, pageSize: Number, totalItems: Number, totalPages: Number, bound: Bound, itemType: String)
   */
  async _getPage(
    { bound, itemType, page, pageSize, mode }: {
      bound?: Bound;
      itemType: string;
      page: number;
      pageSize?: number;
      mode?: SortMode;
    },
  ): Promise<
    Array<
      | {
        page: number;
        pageSize: number;
        totalItems: number;
        totalPages: number;
        mode: SortMode;
        bound: Bound;
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
    const resolvedPageSize = pageSize ?? DEFAULT_PAGE_SIZE;
    if (!this.isValidPageSize(resolvedPageSize)) {
      return [{ error: "pageSize must be a positive integer" }];
    }
    if (mode !== undefined && !this.isValidMode(mode)) {
      return [{ error: "Invalid mode. Must be one of: createdAt, score" }];
    }

    const normalizedItemType = this.normalizeItemType(itemType);
    if (!normalizedItemType) {
      return [{ error: "itemType must be a non-empty string" }];
    }

    const normalizedBound = this.normalizeBound(bound);
    const listDoc = await this.lists.findOne({
      _id: this.getListId({
        bound: normalizedBound,
        itemType: normalizedItemType,
      }),
    });

    if (!listDoc) {
      return [{
        page,
        pageSize: resolvedPageSize,
        totalItems: 0,
        totalPages: 0,
        mode: DEFAULT_MODE,
        bound: normalizedBound,
        itemType: normalizedItemType,
        items: [],
      }];
    }

    const entryFilter: Filter<PaginationEntryState> = {
      bound: normalizedBound,
      itemType: normalizedItemType,
    };

    const totalItems = await this.entries.countDocuments(entryFilter);
    const totalPages = totalItems === 0
      ? 0
      : Math.ceil(totalItems / resolvedPageSize);
    const skip = (page - 1) * resolvedPageSize;

    // Allow request-time mode override (for example GET /posts?sort=score)
    // without mutating list-level default mode.
    const resolvedMode = mode ?? listDoc.mode;
    const sort: Sort = resolvedMode === "score"
      ? { score: -1, createdAt: -1, item: 1 }
      : { createdAt: -1, item: 1 };

    const docs = await this.entries.find(
      entryFilter,
      { projection: { item: 1 } },
    ).sort(sort).skip(skip).limit(resolvedPageSize).toArray();

    return [{
      page,
      pageSize: resolvedPageSize,
      totalItems,
      totalPages,
      mode: resolvedMode,
      bound: listDoc.bound,
      itemType: listDoc.itemType,
      items: docs.map((d) => d.item),
    }];
  }

  /**
   * Query: _getList (bound?: Bound, itemType: String) : (list: List | null)
   */
  async _getList(
    { bound, itemType }: { bound?: Bound; itemType: string },
  ): Promise<Array<{ list: PaginationListState | null }>> {
    await this.ensureIndexes();
    const normalizedItemType = this.normalizeItemType(itemType);
    if (!normalizedItemType) {
      return [{ list: null }];
    }

    const normalizedBound = this.normalizeBound(bound);
    const listDoc = await this.lists.findOne({
      _id: this.getListId({
        bound: normalizedBound,
        itemType: normalizedItemType,
      }),
    });
    return [{ list: listDoc }];
  }

  /**
   * Query: _getListsByBound (bound?: Bound, itemType?: String) : (lists: List<{bound: Bound, itemType: String}>)
   */
  async _getListsByBound(
    { bound, itemType }: { bound?: Bound; itemType?: string },
  ): Promise<Array<{ lists: ListRef[] } | { error: string }>> {
    await this.ensureIndexes();
    const normalizedBound = this.normalizeBound(bound);

    const filter: Filter<PaginationListState> = { bound: normalizedBound };
    if (itemType !== undefined) {
      const normalizedItemType = this.normalizeItemType(itemType);
      if (!normalizedItemType) {
        return [{ error: "itemType must be a non-empty string" }];
      }
      filter.itemType = normalizedItemType;
    }

    const docs = await this.lists.find(
      filter,
      { projection: { bound: 1, itemType: 1 } },
    ).toArray();

    return [{
      lists: docs.map((d) => ({ bound: d.bound, itemType: d.itemType })),
    }];
  }

  /**
   * Query: _hasEntry (bound?: Bound, itemType: String, item: Item) : (hasEntry: Flag)
   */
  async _hasEntry(
    { bound, itemType, item }: { bound?: Bound; itemType: string; item: Item },
  ): Promise<Array<{ hasEntry: boolean }>> {
    await this.ensureIndexes();
    const normalizedItemType = this.normalizeItemType(itemType);
    if (!normalizedItemType) {
      return [{ hasEntry: false }];
    }

    const normalizedBound = this.normalizeBound(bound);
    const entryId = this.getEntryId({
      bound: normalizedBound,
      itemType: normalizedItemType,
      item,
    });

    const doc = await this.entries.findOne(
      { _id: entryId },
      { projection: { _id: 1 } },
    );
    return [{ hasEntry: !!doc }];
  }
}
