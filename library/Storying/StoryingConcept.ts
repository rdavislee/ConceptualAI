import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Declare collection prefix, use concept name
const PREFIX = "Storying" + ".";

// Generic external parameter types
// Storying [Author]
export type Author = ID;
export type Story = ID;

/**
 * a set of Stories with
 *   an author Author
 *   a content Object
 *   a postedAt DateTime
 *   an expiresAt DateTime
 */
interface StoryState {
  _id: Story;
  author: Author;
  content: Record<string, unknown>;
  postedAt: Date;
  expiresAt: Date;
}

interface ViewState {
  _id: string;
  story: Story;
  viewer: Author;
  viewedAt: Date;
}

/**
 * @concept Storying
 * @purpose Broadcast ephemeral content to a group of viewers.
 * @principle A story is created by an author and expires after a set duration.
 */
export default class StoryingConcept {
  stories: Collection<StoryState>;
  views: Collection<ViewState>;

  constructor(private readonly db: Db) {
    this.stories = this.db.collection<StoryState>(PREFIX + "stories");
    this.views = this.db.collection<ViewState>(PREFIX + "views");
  }

  async ensureIndexes(): Promise<void> {
    await this.stories.createIndex({ author: 1, expiresAt: 1, postedAt: -1 });
    await this.stories.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  /**
   * Action: post (author: Author, content: Object, durationSeconds: Number) : (story: Story)
   *
   * **requires** content is a non-empty object; durationSeconds > 0
   *
   * **effects** creates a new Story with the given author and content; sets expiresAt to now + durationSeconds
   */
  async post(
    { author, content, durationSeconds }: {
      author: Author;
      content: Record<string, unknown>;
      durationSeconds: number;
    },
  ): Promise<{ story: Story } | { error: string }> {
    // Validate content: must be a non-null object with at least one defined value
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return { error: "Story content cannot be empty" };
    }
    const hasValue = Object.values(content).some((v) => v !== undefined);
    if (!hasValue) {
      return { error: "Story content cannot be empty" };
    }

    if (durationSeconds <= 0) {
      return { error: "Duration must be greater than 0" };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
    const storyId = freshID() as Story;

    await this.stories.insertOne({
      _id: storyId,
      author,
      content,
      postedAt: now,
      expiresAt,
    });

    return { story: storyId };
  }

  /**
   * Action: recordView (story: Story, viewer: Author) : (ok: Flag)
   *
   * **requires** story exists
   *
   * **effects** creates a View record with viewedAt := now
   */
  async recordView(
    { story, viewer }: { story: Story; viewer: Author },
  ): Promise<{ ok: boolean } | { error: string }> {
    const storyRecord = await this.stories.findOne({ _id: story });
    if (!storyRecord) {
      return { error: "Story not found" };
    }
    if (storyRecord.author === viewer) {
      return { error: "Author cannot view own story" };
    }

    const existingView = await this.views.findOne({ story, viewer });
    if (existingView) {
      return { error: "View already recorded" };
    }

    const viewId = `${story}:${viewer}:${freshID()}`;
    await this.views.insertOne({
      _id: viewId,
      story,
      viewer,
      viewedAt: new Date(),
    });

    return { ok: true };
  }

  /**
   * Cleanup: deleteByAuthor (author) - removes all stories by author (e.g. account deletion).
   */
  async deleteByAuthor({ author }: { author: Author }): Promise<{ ok: boolean }> {
    await this.stories.deleteMany({ author });
    return { ok: true };
  }

  /**
   * Action: expire (story: Story) : (ok: Flag)
   *
   * **requires** story exists
   *
   * **effects** deletes the story and all associated views
   */
  async expire(
    { story }: { story: Story },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.stories.deleteOne({ _id: story });
    if (res.deletedCount === 0) {
      return { error: "Story not found" };
    }

    await this.views.deleteMany({ story });

    return { ok: true };
  }

  /**
   * Query: _getViews (story: Story) : (views: Set<View>)
   */
  async _getViews(
    { story }: { story: Story },
  ): Promise<Array<{ views: Array<{ viewer: Author; viewedAt: Date }> }>> {
    const viewDocs = await this.views.find({ story }).sort({ viewedAt: 1 }).toArray();
    return [{
      views: viewDocs.map((v) => ({ viewer: v.viewer, viewedAt: v.viewedAt })),
    }];
  }

  /**
   * Query: _getActiveStories (authors: Set<Author>) : (stories: Set<Story>)
   *
   * **effects** returns all non-expired stories by the given authors, sorted by newest first
   */
  async _getActiveStories(
    { authors }: { authors: Author[] },
  ): Promise<Array<{ stories: StoryState[] }>> {
    const stories = await this.stories.find({
      author: { $in: authors },
      expiresAt: { $gt: new Date() },
    }).sort({ postedAt: -1 }).toArray();
    return [{ stories }];
  }
}
