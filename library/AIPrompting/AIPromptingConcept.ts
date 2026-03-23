import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";
import { generateObject, generateText, type JSONSchema } from "@utils/ai.ts";

export type Owner = ID;

const PREFIX = "AIPrompting" + ".";

export interface PromptRun {
  promptRunId: ID;
  owner: Owner;
  systemPrompt?: string;
  userPrompt: string;
  status: string;
  outputText?: string;
  outputJson?: Record<string, unknown>;
  error?: string;
}

interface PromptRunState {
  _id: ID;
  owner: Owner;
  systemPrompt?: string;
  userPrompt: string;
  status: string;
  outputText?: string;
  outputJson?: Record<string, unknown>;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

function isNonEmptySchema(schema: object): boolean {
  return Object.keys(schema as Record<string, unknown>).length > 0;
}

/**
 * @concept AIPrompting
 * @purpose One-off AI prompts with persistent records of inputs and outputs.
 */
export default class AIPromptingConcept {
  readonly runs: Collection<PromptRunState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.runs = this.db.collection<PromptRunState>(PREFIX + "runs");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.runs.createIndex({ owner: 1, createdAt: -1 });
    this.indexesCreated = true;
  }

  private toPromptRun(doc: PromptRunState): PromptRun {
    return {
      promptRunId: doc._id,
      owner: doc.owner,
      systemPrompt: doc.systemPrompt,
      userPrompt: doc.userPrompt,
      status: doc.status,
      outputText: doc.outputText,
      outputJson: doc.outputJson,
      error: doc.error,
    };
  }

  /**
   * runTextPrompt (owner: Owner, userPrompt: String, systemPrompt?: String) : (promptRunId: ID, outputText?: String, error?: String)
   */
  async runTextPrompt(
    { owner, userPrompt, systemPrompt }: {
      owner: Owner;
      userPrompt: string;
      systemPrompt?: string;
    },
  ): Promise<{ promptRunId: string; outputText?: string; error?: string } | { error: string }> {
    const up = userPrompt?.trim() ?? "";
    if (!up) {
      return { error: "userPrompt cannot be empty" };
    }

    const promptRunId = freshID();
    const now = new Date();
    await this.runs.insertOne({
      _id: promptRunId,
      owner,
      systemPrompt,
      userPrompt: up,
      status: "thinking",
      createdAt: now,
      updatedAt: now,
    });

    const sys = systemPrompt ?? "";
    try {
      const outputText = await generateText(up, sys);
      const trimmed = outputText?.trim() ?? "";
      const doneAt = new Date();
      if (!trimmed) {
        await this.runs.updateOne(
          { _id: promptRunId },
          {
            $set: {
              status: "done",
              error: "Empty AI response",
              updatedAt: doneAt,
            },
          },
        );
        return { promptRunId, error: "Empty AI response" };
      }
      await this.runs.updateOne(
        { _id: promptRunId },
        {
          $set: {
            status: "done",
            outputText: trimmed,
            updatedAt: doneAt,
          },
          $unset: { error: "" },
        },
      );
      return { promptRunId, outputText: trimmed };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await this.runs.updateOne(
        { _id: promptRunId },
        {
          $set: {
            status: "done",
            error: errMsg,
            updatedAt: new Date(),
          },
        },
      );
      return { promptRunId, error: errMsg };
    }
  }

  /**
   * runStructuredPrompt (owner: Owner, userPrompt: String, schema: Object, systemPrompt?: String) : (promptRunId: ID, outputJson?: Object, error?: String)
   */
  async runStructuredPrompt(
    { owner, userPrompt, schema, systemPrompt }: {
      owner: Owner;
      userPrompt: string;
      schema: JSONSchema;
      systemPrompt?: string;
    },
  ): Promise<
    | { promptRunId: string; outputJson?: Record<string, unknown>; error?: string }
    | { error: string }
  > {
    const up = userPrompt?.trim() ?? "";
    if (!up) {
      return { error: "userPrompt cannot be empty" };
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || !isNonEmptySchema(schema)) {
      return { error: "schema must be a non-empty object" };
    }

    const promptRunId = freshID();
    const now = new Date();
    await this.runs.insertOne({
      _id: promptRunId,
      owner,
      systemPrompt,
      userPrompt: up,
      status: "thinking",
      createdAt: now,
      updatedAt: now,
    });

    const sys = systemPrompt ?? "";
    try {
      const outputJson = await generateObject<Record<string, unknown>>(up, sys, schema);
      const doneAt = new Date();
      await this.runs.updateOne(
        { _id: promptRunId },
        {
          $set: {
            status: "done",
            outputJson: outputJson ?? {},
            updatedAt: doneAt,
          },
          $unset: { error: "" },
        },
      );
      return { promptRunId, outputJson: outputJson ?? {} };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await this.runs.updateOne(
        { _id: promptRunId },
        {
          $set: {
            status: "done",
            error: errMsg,
            updatedAt: new Date(),
          },
        },
      );
      return { promptRunId, error: errMsg };
    }
  }

  /**
   * deleteRun (promptRunId: ID) : (ok: Flag)
   */
  async deleteRun(
    { promptRunId }: { promptRunId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.runs.deleteOne({ _id: promptRunId as ID });
    if (res.deletedCount === 0) {
      return { error: "Prompt run not found" };
    }
    return { ok: true };
  }

  /**
   * deleteAllRunsForOwner (owner: Owner) : (ok: Flag)
   */
  async deleteAllRunsForOwner({ owner }: { owner: Owner }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.runs.deleteMany({ owner });
    return { ok: true };
  }

  /**
   * _getRun (promptRunId: ID) : (promptRun: PromptRun)
   */
  async _getRun(
    { promptRunId }: { promptRunId: string },
  ): Promise<Array<{ promptRun: PromptRun }>> {
    const doc = await this.runs.findOne({ _id: promptRunId as ID });
    if (!doc) return [];
    return [{ promptRun: this.toPromptRun(doc) }];
  }

  /**
   * _listRunsForOwner (owner: Owner) : (promptRunIds: set of ID)
   */
  async _listRunsForOwner(
    { owner }: { owner: Owner },
  ): Promise<Array<{ promptRunIds: ID[] }>> {
    await this.ensureIndexes();
    const docs = await this.runs.find({ owner }, { projection: { _id: 1 } }).toArray();
    return [{ promptRunIds: docs.map((d) => d._id) }];
  }

  /**
   * _getLatestSuccessfulRun (owner: Owner) : (promptRunId: ID)
   */
  async _getLatestSuccessfulRun(
    { owner }: { owner: Owner },
  ): Promise<Array<{ promptRunId?: ID }>> {
    await this.ensureIndexes();
    const doc = await this.runs.findOne(
      {
        owner,
        status: "done",
        $or: [
          { error: { $exists: false } },
          { error: "" },
        ],
      },
      { sort: { createdAt: -1 } },
    );
    if (!doc) return [];
    return [{ promptRunId: doc._id }];
  }
}
