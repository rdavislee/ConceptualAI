import { Collection, Db, ObjectId } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Posting [Author, Post]
export type Author = ID;
export type Post = ID;

const PREFIX = "Posting" + ".";

// State: a set of Posts with a post ID, an author ID...
interface PostState {
  _id: ObjectId; // post ID
  author: Author;
  content: Record<string, any>;
  type?: string;
  metadata?: Record<string, any>;
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

  constructor(private readonly db: Db) {
    this.posts = this.db.collection<PostState>(PREFIX + "posts");
  }

  /**
   * Action: createPost (author: authorID, content: Object, type?: String, metadata?: Object) : (post: postID)
   * requires: content is not empty
   * effects: create post with createdAt := now, updatedAt := now
   */
  async createPost(
    { author, content, type, metadata }: {
      author: Author;
      content: Record<string, any>;
      type?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<{ postId: string } | { error: string }> {
    if (!content || typeof content !== "object" || Object.keys(content).length === 0) {
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
   * requires: post exists, author of post is authorID, content is not empty
   * effects: update post and updatedAt := now
   */
  async editPost(
    { postId, author, content, type, metadata }: {
      postId: string;
      author: Author;
      content: Record<string, any>;
      type?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!content || typeof content !== "object" || Object.keys(content).length === 0) {
      return { error: "Post content cannot be empty" };
    }

    let oid: ObjectId;
    try {
      oid = new ObjectId(postId);
    } catch {
      return { error: "Invalid post ID" };
    }

    const update: any = { $set: { content, updatedAt: new Date() } };
    if (type !== undefined) update.$set.type = type;
    if (metadata !== undefined) update.$set.metadata = metadata;

    const res = await this.posts.updateOne(
      { _id: oid, author },
      update,
    );

    if (res.matchedCount === 0) {
      return { error: "Post not found or author mismatch" };
    }

    return { ok: true };
  }

  /**
   * Action: deletePost (post: postID, author: authorID) : (ok: Flag)
   * requires: post exists, author of post is authorID
   * effects: delete the post
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
   * Query: _getPostsByAuthor(author: authorID) : (posts: Set<Post>)
   */
  async _getPostsByAuthor(
    { author }: { author: Author },
  ): Promise<Array<{ posts: PostState[] }>> {
    const posts = await this.posts.find({ author }).sort({ createdAt: -1 })
      .toArray();
    return [{ posts }];
  }

  /**
   * Query: _getPostsByType(type: string) : (posts: Set<Post>)
   */
  async _getPostsByType(
    { type }: { type: string },
  ): Promise<Array<{ posts: PostState[] }>> {
    const posts = await this.posts.find({ type }).sort({ createdAt: -1 })
      .toArray();
    return [{ posts }];
  }

  /**
   * Query: _getPost(post: postID) : (post: Post)
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
   */
  async _allPosts(): Promise<Array<{ posts: PostState[] }>> {
    const posts = await this.posts.find().sort({ createdAt: -1 }).toArray();
    return [{ posts }];
  }
}
