import { Collection, Db, ObjectId } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Posting [Author, Post]
export type Author = ID;
export type Post = ID;

const PREFIX = "Posting" + ".";

/**
 * a set of Posts with
 *   a post ID
 *   an author Author
 *   a content Object
 *   a type? String
 *   a metadata? Object
 *   a createdAt DateTime
 *   an updatedAt DateTime
 */
interface PostState {
  _id: ObjectId; // post ID
  author: Author;
  content: Record<string, unknown>;
  type?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept Posting
 * @purpose Allows authors to create and manage standalone blocks of content (posts).
 * @principle A post is created by exactly one author; the author can edit or delete their own posts.
 * @state
 *  a set of Posts with a post ID, an author ID, a content Object, a type? String, a metadata? Object, a createdAt DateTime, an updatedAt DateTime
 */
export default class PostingConcept {
  posts: Collection<PostState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.posts = this.db.collection<PostState>(PREFIX + "posts");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.posts.createIndex({ author: 1, createdAt: -1 }),
      this.posts.createIndex({ type: 1, createdAt: -1 }),
      this.posts.createIndex({ createdAt: -1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: createPost (author: authorID, content: Object, type?: String, metadata?: Object) : (post: postID)
   *
   * **requires** content is not empty (must be a non-null object with at least one defined value)
   *
   * **effects** creates a new post with createdAt := now, updatedAt := now
   */
  async createPost(
    { author, content, type, metadata }: {
      author: Author;
      content: Record<string, unknown>;
      type?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ postId: string } | { error: string }> {
    // Validate content: must be a non-null object with at least one defined value
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return { error: "Post content cannot be empty" };
    }
    // Check if content has at least one non-undefined value
    const hasValue = Object.values(content).some((v) => v !== undefined);
    if (!hasValue) {
      return { error: "Post content cannot be empty" };
    }

    const now = new Date();
    const res = await this.posts.insertOne({
      _id: new ObjectId(),
      author,
      content,
      type,
      metadata,
      createdAt: now,
      updatedAt: now,
    });

    return { postId: res.insertedId.toHexString() };
  }

  /**
   * Action: editPost (post: postID, author: authorID, content: Object, type?: String, metadata?: Object) : (ok: Flag)
   *
   * **requires** post exists; author of post is authorID; content is not empty
   *
   * **effects** updates the post content and sets updatedAt := now
   */
  async editPost(
    { postId, author, content, type, metadata }: {
      postId: string;
      author: Author;
      content: Record<string, unknown>;
      type?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    // Validate content: must be a non-null object with at least one defined value
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return { error: "Post content cannot be empty" };
    }
    const hasValue = Object.values(content).some((v) => v !== undefined);
    if (!hasValue) {
      return { error: "Post content cannot be empty" };
    }

    let oid: ObjectId;
    try {
      oid = new ObjectId(postId);
    } catch {
      return { error: "Invalid post ID" };
    }

    const updateDoc: {
      $set: {
        content: Record<string, unknown>;
        updatedAt: Date;
        type?: string;
        metadata?: Record<string, unknown>;
      };
    } = { $set: { content, updatedAt: new Date() } };
    if (type !== undefined) updateDoc.$set.type = type;
    if (metadata !== undefined) updateDoc.$set.metadata = metadata;

    const res = await this.posts.updateOne(
      { _id: oid, author },
      updateDoc,
    );

    if (res.matchedCount === 0) {
      return { error: "Post not found or author mismatch" };
    }

    return { ok: true };
  }

  /**
   * Action: deletePost (post: postID, author: authorID) : (ok: Flag)
   *
   * **requires** post exists; author of post is authorID
   *
   * **effects** deletes the post
   */
  async deletePost(
    { postId, author }: { postId: string; author: Author },
  ): Promise<{ ok: boolean } | { error: string }> {
    let oid: ObjectId;
    try {
      oid = new ObjectId(postId);
    } catch {
      return { error: "Invalid post ID" };
    }

    const res = await this.posts.deleteOne({ _id: oid, author });

    if (res.deletedCount === 0) {
      return { error: "Post not found or author mismatch" };
    }

    return { ok: true };
  }

  /**
   * Delete lifecycle: remove all posts by an author (for account deletion).
   */
  async deleteByAuthor({ author }: { author: Author }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.posts.deleteMany({ author });
    return { ok: true };
  }

  /**
   * Query: _getPostsByAuthor(author: authorID) : (posts: Set<Post>)
   *
   * **effects** returns all posts by the given author, sorted by newest first
   */
  async _getPostsByAuthor(
    { author, limit, skip }: { author: Author; limit?: number; skip?: number },
  ): Promise<Array<{ posts: PostState[] }>> {
    await this.ensureIndexes();
    let cursor = this.posts.find({ author }).sort({ createdAt: -1 });
    if (skip != null) cursor = cursor.skip(skip);
    if (limit != null) cursor = cursor.limit(limit);
    const posts = await cursor.toArray();
    return [{ posts }];
  }

  /**
   * Query: _getPostsByType(type: string) : (posts: Set<Post>)
   *
   * **effects** returns all posts of the given type, sorted by newest first
   */
  async _getPostsByType(
    { type, limit, skip }: { type: string; limit?: number; skip?: number },
  ): Promise<Array<{ posts: PostState[] }>> {
    await this.ensureIndexes();
    let cursor = this.posts.find({ type }).sort({ createdAt: -1 });
    if (skip != null) cursor = cursor.skip(skip);
    if (limit != null) cursor = cursor.limit(limit);
    const posts = await cursor.toArray();
    return [{ posts }];
  }

  /**
   * Query: _getPost(post: postID) : (post: Post | null)
   *
   * **effects** returns the post with the given ID, or null if not found
   */
  async _getPost(
    { postId }: { postId: string },
  ): Promise<Array<{ post: PostState | null }>> {
    let oid: ObjectId;
    try {
      oid = new ObjectId(postId);
    } catch {
      return [{ post: null }];
    }
    const post = await this.posts.findOne({ _id: oid });
    return [{ post }];
  }

  /**
   * Query: _allPosts() : (posts: Set<Post>)
   *
   * **effects** returns all posts, sorted by newest first
   */
  async _allPosts(
    { limit, skip }: { limit?: number; skip?: number } = {},
  ): Promise<Array<{ posts: PostState[] }>> {
    await this.ensureIndexes();
    let cursor = this.posts.find().sort({ createdAt: -1 });
    if (skip != null) cursor = cursor.skip(skip);
    if (limit != null) cursor = cursor.limit(limit);
    const posts = await cursor.toArray();
    return [{ posts }];
  }
}
