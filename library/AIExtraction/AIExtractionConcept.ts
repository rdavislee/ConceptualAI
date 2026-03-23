import { Collection, Db } from "npm:mongodb";
import { generateObject, JSONSchema } from "@utils/ai.ts";
import { freshID } from "@utils/database.ts";
import { ID } from "@utils/types.ts";

export type Owner = ID;

const PREFIX = "AIExtraction" + ".";

export interface Extractor {
  extractorId: ID;
  owner: Owner;
  name: string;
  schema: Record<string, unknown>;
  instructions?: string;
  status: string;
  input: string;
  outputJson?: Record<string, unknown>;
  error?: string;
}

interface ExtractorDoc {
  _id: ID;
  owner: Owner;
  name: string;
  schema: Record<string, unknown>;
  instructions?: string;
  status: string;
  input: string;
  outputJson?: Record<string, unknown>;
  error?: string;
}

function isNonEmptyRecord(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length > 0;
}

function docToExtractor(doc: ExtractorDoc): Extractor {
  return {
    extractorId: doc._id,
    owner: doc.owner,
    name: doc.name,
    schema: doc.schema,
    instructions: doc.instructions,
    status: doc.status,
    input: doc.input,
    outputJson: doc.outputJson ?? undefined,
    error: doc.error ?? undefined,
  };
}

/**
 * @concept AIExtraction
 * @purpose Extract structured data from text using persisted JSON schemas and extractor state.
 */
export default class AIExtractionConcept {
  extractors: Collection<ExtractorDoc>;

  constructor(private readonly db: Db) {
    this.extractors = this.db.collection<ExtractorDoc>(PREFIX + "extractors");
  }

  /**
   * Action: createExtractor (owner, name, schema, instructions?) : (extractorId: ID)
   */
  async createExtractor(
    { owner, name, schema, instructions }: {
      owner: Owner;
      name: string;
      schema: Record<string, unknown>;
      instructions?: string;
    },
  ): Promise<{ extractorId: ID } | { error: string }> {
    if (!name.trim()) {
      return { error: "Name must not be empty" };
    }
    if (!isNonEmptyRecord(schema)) {
      return { error: "Schema must not be empty" };
    }
    const extractorId = freshID();
    await this.extractors.insertOne({
      _id: extractorId,
      owner,
      name: name.trim(),
      schema,
      instructions,
      status: "idle",
      input: "",
    });
    return { extractorId };
  }

  /**
   * Action: extract (extractor, content) : (outputJson?, error?)
   */
  async extract(
    { extractor, content }: { extractor: Extractor; content: string },
  ): Promise<{ outputJson?: Record<string, unknown>; error?: string }> {
    const doc = await this.extractors.findOne({ _id: extractor.extractorId });
    if (!doc) {
      return { error: "Extractor not found" };
    }
    if (!content.trim()) {
      return { error: "Content must not be empty" };
    }

    await this.extractors.updateOne(
      { _id: extractor.extractorId },
      {
        $set: {
          status: "thinking",
          input: content.trim(),
        },
        $unset: { outputJson: "", error: "" },
      },
    );

    const ext = docToExtractor({ ...doc, status: "thinking", input: content.trim() });
    const systemPrompt =
      `Extract structured data matching the JSON schema. Return only valid JSON for the schema. ` +
      (ext.instructions ? `Instructions: ${ext.instructions}` : "");
    const userPrompt = `Content:\n${content.trim()}`;

    try {
      const out = await generateObject<Record<string, unknown>>(
        userPrompt,
        systemPrompt,
        ext.schema as JSONSchema,
      );
      await this.extractors.updateOne(
        { _id: extractor.extractorId },
        {
          $set: {
            status: "done",
            outputJson: out,
          },
          $unset: { error: "" },
        },
      );
      return { outputJson: out };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.extractors.updateOne(
        { _id: extractor.extractorId },
        {
          $set: {
            status: "done",
            error: msg,
          },
          $unset: { outputJson: "" },
        },
      );
      return { error: msg };
    }
  }

  /**
   * Action: deleteExtractor (extractorId) : (ok: Flag)
   */
  async deleteExtractor(
    { extractorId }: { extractorId: ID },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.extractors.deleteOne({ _id: extractorId });
    if (res.deletedCount === 0) {
      return { error: "Extractor not found" };
    }
    return { ok: true };
  }

  /**
   * Action: deleteAllExtractorsForOwner (owner) : (ok: Flag)
   */
  async deleteAllExtractorsForOwner(
    { owner }: { owner: Owner },
  ): Promise<{ ok: boolean }> {
    await this.extractors.deleteMany({ owner });
    return { ok: true };
  }

  /**
   * Query: _getExtractor (extractorId) : (extractor)
   */
  async _getExtractor(
    { extractorId }: { extractorId: ID },
  ): Promise<{ extractor: Extractor } | { error: string }> {
    const doc = await this.extractors.findOne({ _id: extractorId });
    if (!doc) {
      return { error: "Extractor not found" };
    }
    return { extractor: docToExtractor(doc) };
  }

  /**
   * Query: _listExtractorsForOwner (owner) : (extractorIds)
   */
  async _listExtractorsForOwner(
    { owner }: { owner: Owner },
  ): Promise<{ extractorIds: ID[] }> {
    const docs = await this.extractors.find({ owner }, { projection: { _id: 1 } })
      .toArray();
    const ids = docs.map((d) => d._id);
    return { extractorIds: ids };
  }
}
