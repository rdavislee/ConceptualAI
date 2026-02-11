import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Rating [Subject, Target]
export type Subject = ID;
export type Target = ID;

const PREFIX = "Rating" + ".";

const DEFAULT_MIN_SCORE = 1;
const DEFAULT_MAX_SCORE = 5;

interface RatingState {
  _id: string; // subject:target
  subject: Subject;
  target: Target;
  score: number;
  createdAt: Date;
}

/**
 * @concept Rating
 * @purpose Allow subjects to provide quantitative feedback (scores) on targets, and aggregate these scores to show overall sentiment.
 * @principle If a subject rates a target with a score, then the score is stored; if they rate it again, the old score is replaced; if they remove their rating, the score is deleted.
 */
export default class RatingConcept {
  ratings: Collection<RatingState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.ratings = this.db.collection<RatingState>(PREFIX + "ratings");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.ratings.createIndex({ target: 1 });
    this.indexesCreated = true;
  }

  /**
   * Action: rate (subject: Subject, target: Target, score: Number) : (ok: Flag)
   */
  async rate(
    { subject, target, score }: { subject: Subject; target: Target; score: number },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    if (typeof score !== "number" || isNaN(score)) {
      return { error: "Score must be a number" };
    }
    if (score < DEFAULT_MIN_SCORE || score > DEFAULT_MAX_SCORE) {
      return { error: `Score must be between ${DEFAULT_MIN_SCORE} and ${DEFAULT_MAX_SCORE}` };
    }

    const _id = `${subject}:${target}`;
    await this.ratings.updateOne(
      { _id },
      { $set: { subject, target, score, createdAt: new Date() } },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * deleteBySubject (subject: Subject): (deleted: number)
   * @effects Removes all ratings by the subject (account deletion cleanup).
   */
  async deleteBySubject(
    { subject }: { subject: Subject },
  ): Promise<{ deleted: number }> {
    await this.ensureIndexes();
    const res = await this.ratings.deleteMany({ subject });
    return { deleted: res.deletedCount };
  }

  /**
   * deleteByTarget (target: Target): (deleted: number)
   * @effects Removes all ratings for the target (target deletion cleanup).
   */
  async deleteByTarget(
    { target }: { target: Target },
  ): Promise<{ deleted: number }> {
    await this.ensureIndexes();
    const res = await this.ratings.deleteMany({ target });
    return { deleted: res.deletedCount };
  }

  /**
   * Action: removeRating (subject: Subject, target: Target) : (ok: Flag)
   */
  async removeRating(
    { subject, target }: { subject: Subject; target: Target },
  ): Promise<{ ok: boolean } | { error: string }> {
    const _id = `${subject}:${target}`;
    const res = await this.ratings.deleteOne({ _id });
    if (res.deletedCount === 0) {
      return { error: "No rating found to remove" };
    }
    return { ok: true };
  }

  /**
   * Query: _getAverageRating (target: Target) : (average: Number, count: Number)
   */
  async _getAverageRating(
    { target }: { target: Target },
  ): Promise<Array<{ average: number; count: number }>> {
    await this.ensureIndexes();
    const pipeline = [
      { $match: { target } },
      {
        $group: {
          _id: "$target",
          average: { $avg: "$score" },
          count: { $sum: 1 },
        },
      },
    ];
    const results = await this.ratings.aggregate(pipeline).toArray();
    if (results.length === 0) {
      return [{ average: 0, count: 0 }];
    }
    return [{ average: results[0].average, count: results[0].count }];
  }

  /**
   * Query: _getUserRating (subject: Subject, target: Target) : (score: Number | null)
   */
  async _getUserRating(
    { subject, target }: { subject: Subject; target: Target },
  ): Promise<Array<{ score: number | null }>> {
    const _id = `${subject}:${target}`;
    const rating = await this.ratings.findOne({ _id });
    return [{ score: rating ? rating.score : null }];
  }
}
