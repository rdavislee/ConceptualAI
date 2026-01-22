import { Collection, Db, ObjectId } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Commenting [Item, Author]
export type Item = ID;
export type Author = ID;

const PREFIX = "Commenting" + ".";

// State: a set of Comments with a comment ID, an item ID...
interface CommentState {
  _id: ObjectId; // comment ID
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

  constructor(private readonly db: Db) {
    this.comments = this.db.collection<CommentState>(PREFIX + "comments");
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

    const now = new Date();
    const res = await this.comments.insertOne({
      _id: new ObjectId(),
      item,
      author,
      content,
      createdAt: now,
      updatedAt: now,
    });

    return { commentId: res.insertedId.toHexString() };
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

    let oid: ObjectId;
    try {
      oid = new ObjectId(commentId);
    } catch {
      return { error: "Invalid comment ID" };
    }

    const res = await this.comments.updateOne(
      { _id: oid, author },
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
    let oid: ObjectId;
    try {
      oid = new ObjectId(commentId);
    } catch {
      return { error: "Invalid comment ID" };
    }

    const res = await this.comments.deleteOne({ _id: oid, author });

    if (res.deletedCount === 0) {
      return { error: "Comment not found or author mismatch" };
    }

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
    let oid: ObjectId;
    try {
      oid = new ObjectId(commentId);
    } catch {
      return [{ comment: null }];
    }
    const comment = await this.comments.findOne({ _id: oid });
    return [{ comment }];
  }
}
