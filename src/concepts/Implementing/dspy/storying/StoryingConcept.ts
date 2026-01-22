import { Collection, Db } from "npm:mongodb";
import { ID, Empty } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
// Storying [Author, Story]
export type Author = ID;
export type Story = ID;

const PREFIX = "Storying" + ".";

// State: a set of Stories
interface StoryState {
  _id: Story;
  author: Author;
  content: Record<string, any>;
  type?: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * @concept Storying [Author, Story]
 * @purpose Allows authors to create short-lived stories that expire after a set time.
 * @principle A story is created by an author and is automatically deleted after its expiration time.
 * @state
 *   a set of Stories with
 *     a story ID
 *     an author ID
 *     a content Object
 *     a type? String
 *     a createdAt DateTime
 *     a expiresAt DateTime
 */
export default class StoryingConcept {
  stories: Collection<StoryState>;

  constructor(private readonly db: Db) {
    this.stories = this.db.collection<StoryState>(PREFIX + "stories");
  }

  /**
   * createStory (author: authorID, content: Object, durationSeconds: Number, type?: String) : (story: storyID)
   *
   * **requires** content is not empty, durationSeconds > 0
   * **effects** create story with createdAt := now, expiresAt := now + durationSeconds
   */
  async createStory(
    { author, content, durationSeconds, type }: {
      author: Author;
      content: Record<string, any>;
      durationSeconds: number;
      type?: string;
    },
  ): Promise<{ story: Story } | { error: string }> {
    if (
      !content || typeof content !== "object" || Object.keys(content).length === 0
    ) {
      return { error: "Content cannot be empty" };
    }
    if (durationSeconds <= 0) {
      return { error: "Duration must be positive" };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
    const _id = freshID();

    await this.stories.insertOne({
      _id,
      author,
      content,
      type,
      createdAt: now,
      expiresAt,
    });

    return { story: _id };
  }

  /**
   * deleteStory (story: storyID, author: authorID) : (ok: Flag)
   *
   * **requires** story exists, author of story is authorID
   * **effects** delete the story
   */
  async deleteStory(
    { story, author }: { story: Story; author: Author },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.stories.deleteOne({ _id: story, author });

    if (res.deletedCount === 0) {
      return { error: "Story not found or author mismatch" };
    }

    return { ok: true };
  }

  /**
   * checkExpirations () : (count: Number)
   *
   * **effects** delete all stories where expiresAt < now
   */
  async checkExpirations(
    _?: Empty,
  ): Promise<{ count: number }> {
    const now = new Date();
    const res = await this.stories.deleteMany({ expiresAt: { $lt: now } });
    return { count: res.deletedCount };
  }

  /**
   * _getStoriesByAuthor(author: authorID) : (stories: Set<Story>)
   */
  async _getStoriesByAuthor(
    { author }: { author: Author },
  ): Promise<Array<{ stories: StoryState[] }>> {
    const stories = await this.stories.find({ author }).toArray();
    return [{ stories }];
  }

  /**
   * _activeStories() : (stories: Set<Story>)
   */
  async _activeStories(
    _?: Empty,
  ): Promise<Array<{ stories: StoryState[] }>> {
    const now = new Date();
    const stories = await this.stories.find({ expiresAt: { $ge: now } })
      .toArray();
    return [{ stories }];
  }
}