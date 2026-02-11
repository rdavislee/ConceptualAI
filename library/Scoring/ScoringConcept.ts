import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Scoring [Subject, Context]
export type Subject = ID;
export type Context = ID;

const PREFIX = "Scoring" + ".";

interface ScoreState {
  _id: string; // subject:context
  subject: Subject;
  context: Context;
  value: number;
  updatedAt: Date;
}

/**
 * @concept Scoring
 * @purpose Record and query numeric values (scores, points, metrics) associated with a subject in a specific context.
 */
export default class ScoringConcept {
  scores: Collection<ScoreState>;

  constructor(private readonly db: Db) {
    this.scores = this.db.collection<ScoreState>(PREFIX + "scores");
  }

  /** Call once at app startup to create indexes for query performance. */
  async ensureIndexes(): Promise<void> {
    await this.scores.createIndex({ subject: 1 });
    await this.scores.createIndex({ context: 1 });
    await this.scores.createIndex({ subject: 1, context: 1 });
    await this.scores.createIndex({ context: 1, value: -1 });
  }

  private getId(subject: string, context: string): string {
    return `${subject}:${context}`;
  }

  /**
   * Action: setScore (subject: Subject, context: Context, value: Number) : (ok: Flag)
   */
  async setScore(
    { subject, context, value }: { subject: Subject; context: Context; value: number },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (typeof value !== "number" || isNaN(value)) {
      return { error: "Value must be a number" };
    }

    const _id = this.getId(subject, context);
    await this.scores.updateOne(
      { _id },
      { $set: { subject, context, value, updatedAt: new Date() } },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * Action: addScore (subject: Subject, context: Context, delta: Number) : (newScore: Number)
   */
  async addScore(
    { subject, context, delta }: { subject: Subject; context: Context; delta: number },
  ): Promise<{ newScore: number } | { error: string }> {
    if (typeof delta !== "number" || isNaN(delta)) {
      return { error: "Delta must be a number" };
    }

    const _id = this.getId(subject, context);
    const now = new Date();

    // Initial insert ensures document exists for atomic increment if this is the first time
    // But updateOne with upsert and $inc works too, but we need to set other fields on insert
    const res = await this.scores.findOneAndUpdate(
      { _id },
      {
        $inc: { value: delta },
        $set: { updatedAt: now },
        $setOnInsert: { subject, context },
      },
      { upsert: true, returnDocument: "after" },
    );

    if (!res) {
       // Should not happen with upsert
       return { error: "Failed to update score" };
    }

    return { newScore: res.value };
  }

  /**
   * Action: remove (subject: Subject, context: Context) : (ok: Flag)
   */
  async remove(
    { subject, context }: { subject: Subject; context: Context },
  ): Promise<{ ok: boolean } | { error: string }> {
    const _id = this.getId(subject, context);
    const res = await this.scores.deleteOne({ _id });

    if (res.deletedCount === 0) {
      return { error: "Score record not found" };
    }

    return { ok: true };
  }

  /**
   * Action: spend (subject, context, amount)
   */
  async spend(
    { subject, context, amount }: { subject: Subject; context: Context; amount: number },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (amount <= 0) return { error: "Amount must be positive" };

    const _id = this.getId(subject, context);
    const result = await this.scores.updateOne(
      { _id, value: { $gte: amount } },
      {
        $inc: { value: -amount },
        $set: { updatedAt: new Date() },
      },
    );

    if (result.matchedCount === 0) {
      return { error: "Insufficient funds" };
    }

    return { ok: true };
  }

  /**
   * Action: transfer (from, to, context, amount)
   */
  async transfer(
    { from, to, context, amount }: { from: Subject; to: Subject; context: Context; amount: number },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (amount <= 0) return { error: "Amount must be positive" };

    const _idFrom = this.getId(from, context);
    const _idTo = this.getId(to, context);
    const now = new Date();

    // Note: For atomicity across debit+credit, use MongoDB transactions (requires replica set).
    // App can call ensureIndexes() and use MongoClient.startSession().withTransaction() if needed.
    const result = await this.scores.updateOne(
      { _id: _idFrom, value: { $gte: amount } },
      { $inc: { value: -amount }, $set: { updatedAt: now } },
    );
    if (result.matchedCount === 0) {
      return { error: "Insufficient funds" };
    }
    await this.scores.findOneAndUpdate(
      { _id: _idTo },
      {
        $inc: { value: amount },
        $set: { updatedAt: now },
        $setOnInsert: { subject: to, context },
      },
      { upsert: true, returnDocument: "after" },
    );
    return { ok: true };
  }

  /**
   * Cleanup: deleteBySubject (subject) - removes all scores for a subject (e.g. account deletion)
   */
  async deleteBySubject({ subject }: { subject: Subject }): Promise<{ ok: boolean }> {
    await this.scores.deleteMany({ subject });
    return { ok: true };
  }

  /**
   * Cleanup: deleteByContext (context) - removes all scores in a context (e.g. game/context removal)
   */
  async deleteByContext({ context }: { context: Context }): Promise<{ ok: boolean }> {
    await this.scores.deleteMany({ context });
    return { ok: true };
  }

  /**
   * Query: _getScore (subject: Subject, context: Context) : (value: Number)
   */
  async _getScore(
    { subject, context }: { subject: Subject; context: Context },
  ): Promise<Array<{ value: number }>> {
    const _id = this.getId(subject, context);
    const score = await this.scores.findOne({ _id });
    return [{ value: score ? score.value : 0 }];
  }

  /**
   * Query: _getLeaderboard (context: Context, limit: Number, ascending?: Flag) : (scores: List<{subject: Subject, value: Number}>)
   */
  async _getLeaderboard(
    { context, limit, ascending }: { context: Context; limit: number; ascending?: boolean },
  ): Promise<Array<{ scores: { subject: Subject; value: number }[] }>> {
    const sortDir = ascending ? 1 : -1;
    const scores = await this.scores.find({ context })
      .sort({ value: sortDir })
      .limit(limit)
      .toArray();

    return [{
      scores: scores.map((s: ScoreState) => ({ subject: s.subject, value: s.value })),
    }];
  }
}
