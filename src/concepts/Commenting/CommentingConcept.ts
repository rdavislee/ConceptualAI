import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
// Commenting [Item, Author]
export type Item = ID;
export type Author = ID;

const PREFIX = "Commenting" + ".";

// State: a set of Comments with a comment ID, an item ID...
interface CommentState {
  _id: ID; // comment ID
  item: Item;
  author: Author;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept Commenting
 * @purpose Allows users to express thoughts, feedback, or discourse on specific items.
 * @principle A user can post multiple comments on an item; comments can be edited or deleted by the author.
 * @state
 *  a set of Comments with a comment ID, an item ID, an author ID, a content String, a createdAt DateTime, an updatedAt DateTime
 */
export default class CommentingConcept {
  comments: Collection<CommentState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.comments = this.db.collection<CommentState>(PREFIX + "comments");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.comments.createIndex({ item: 1, createdAt: 1 });
    await this.comments.createIndex({ item: 1 });
    await this.comments.createIndex({ author: 1 });
    this.indexesCreated = true;
  }

  /**
   * Action: postComment (item: itemID, author: authorID, content: String) : (comment: commentID)
   * requires: content is not empty
   * effects: create comment with createdAt := now, updatedAt := now
   */
  async postComment(
    { item, author, content }: { item: Item; author: Author; content: string },
  ): Promise<{ commentId: string } | { error: string }> {
    if (!content.trim()) {
      return { error: "Comment content cannot be empty" };
    }

    await this.ensureIndexes();
    const now = new Date();
    const commentId = freshID();
    await this.comments.insertOne({
      _id: commentId,
      item,
      author,
      content,
      createdAt: now,
      updatedAt: now,
    });

    return { commentId };
  }

  /**
   * Action: editComment (comment: commentID, author: authorID, newContent: String) : (ok: Flag)
   * requires: comment exists, author of comment is authorID, newContent is not empty
   * effects: update content and updatedAt := now
   */
  async editComment(
    { commentId, author, newContent }: {
      commentId: string;
      author: Author;
      newContent: string;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!newContent.trim()) {
      return { error: "New content cannot be empty" };
    }

    const res = await this.comments.updateOne(
      { _id: commentId as ID, author },
      { $set: { content: newContent, updatedAt: new Date() } },
    );

    if (res.matchedCount === 0) {
      return { error: "Comment not found or author mismatch" };
    }

    return { ok: true };
  }

  /**
   * Action: deleteComment (comment: commentID, author: authorID) : (ok: Flag)
   * requires: comment exists, author of comment is authorID
   * effects: delete the comment
   */
  async deleteComment(
    { commentId, author }: { commentId: string; author: Author },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.comments.deleteOne({ _id: commentId as ID, author });

    if (res.deletedCount === 0) {
      return { error: "Comment not found or author mismatch" };
    }

    return { ok: true };
  }

  /**
   * Lifecycle: deleteByAuthor (author: Author) : (ok: Flag)
   * Deletes all comments by the given author. Use when author account is deleted.
   */
  async deleteByAuthor({ author }: { author: Author }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.comments.deleteMany({ author });
    return { ok: true };
  }

  /**
   * Lifecycle: deleteByItem (item: Item) : (ok: Flag)
   * Deletes all comments on the given item. Use when item is deleted.
   */
  async deleteByItem({ item }: { item: Item }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.comments.deleteMany({ item });
    return { ok: true };
  }

  /**
   * Query: _getComments(item: itemID) : (comments: Set<Comment>)
   */
  async _getComments(
    { item }: { item: Item },
  ): Promise<Array<{ comments: CommentState[] }>> {
    const comments = await this.comments.find({ item }).sort({ createdAt: 1 })
      .toArray();
    return [{ comments }];
  }

  /**
   * Query: _getCommentCount(item: itemID) : (n: Number)
   */
  async _getCommentCount(
    { item }: { item: Item },
  ): Promise<Array<{ n: number }>> {
    const n = await this.comments.countDocuments({ item });
    return [{ n }];
  }

  /**
   * Query: _getComment(comment: commentID) : (comment: Comment)
   */
  async _getComment(
    { commentId }: { commentId: string },
  ): Promise<Array<{ comment: CommentState | null }>> {
    const comment = await this.comments.findOne({ _id: commentId as ID });
    return [{ comment }];
  }

  /**
   * Query: _getCommentsByIds(commentIds: List<commentID>) : (comments: List<Comment>)
   */
  async _getCommentsByIds(
    { commentIds }: { commentIds: string[] },
  ): Promise<Array<{ comments: CommentState[] }>> {
    if (!Array.isArray(commentIds) || commentIds.length === 0) {
      return [{ comments: [] }];
    }

    const ids = commentIds as ID[];
    const docs = await this.comments.find({ _id: { $in: ids } }).toArray();
    const byId = new Map<ID, CommentState>();
    for (const doc of docs) {
      byId.set(doc._id, doc);
    }

    const comments = ids
      .map((id) => byId.get(id))
      .filter((c): c is CommentState => c !== undefined);

    return [{ comments }];
  }

  /**
   * Query: _getCommentsByItems(items: List<itemID>) : (groups: List<{item: itemID, comments: List<Comment>}>)
   */
  async _getCommentsByItems(
    { items }: { items: Item[] },
  ): Promise<Array<{ groups: Array<{ item: Item; comments: CommentState[] }> }>> {
    if (!Array.isArray(items) || items.length === 0) {
      return [{ groups: [] }];
    }

    const docs = await this.comments.find(
      { item: { $in: items } },
    ).sort({ createdAt: 1 }).toArray();

    const grouped = new Map<Item, CommentState[]>();
    for (const doc of docs) {
      const arr = grouped.get(doc.item) ?? [];
      arr.push(doc);
      grouped.set(doc.item, arr);
    }

    const groups = items.map((item) => ({
      item,
      comments: grouped.get(item) ?? [],
    }));

    return [{ groups }];
  }
}
