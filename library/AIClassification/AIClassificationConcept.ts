import { Collection, Db } from "npm:mongodb";
import { generateObject, JSONSchema } from "@utils/ai.ts";
import { freshID } from "@utils/database.ts";
import { ID } from "@utils/types.ts";

export type Owner = ID;
export type Item = ID;

const PREFIX = "AIClassification" + ".";

export interface Classifier {
  classifierId: ID;
  owner: Owner;
  name: string;
  labels: Record<string, unknown>;
  instructions?: string;
}

export interface ClassificationResult {
  classificationResultId: ID;
  classifier: Classifier;
  item: Item;
  label: string;
  status: string;
}

interface ClassifierDoc {
  _id: ID;
  owner: Owner;
  name: string;
  labels: Record<string, unknown>;
  instructions?: string;
}

interface ClassificationResultDoc {
  _id: ID;
  classifierId: ID;
  item: Item;
  label: string;
  status: string;
  createdAt: Date;
}

function isNonEmptyRecord(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length > 0;
}

function docToClassifier(doc: ClassifierDoc): Classifier {
  return {
    classifierId: doc._id,
    owner: doc.owner,
    name: doc.name,
    labels: doc.labels,
    instructions: doc.instructions,
  };
}

function classificationSchema(labels: Record<string, unknown>): JSONSchema | null {
  const keys = Object.keys(labels);
  if (keys.length === 0) return null;
  return {
    type: "object",
    properties: {
      label: { type: "string", enum: keys },
    },
    required: ["label"],
    additionalProperties: false,
  };
}

/**
 * @concept AIClassification
 * @purpose Assign AI-generated labels to items and persist results for filtering and review.
 */
export default class AIClassificationConcept {
  classifiers: Collection<ClassifierDoc>;
  classificationResults: Collection<ClassificationResultDoc>;

  constructor(private readonly db: Db) {
    this.classifiers = this.db.collection<ClassifierDoc>(PREFIX + "classifiers");
    this.classificationResults = this.db.collection<ClassificationResultDoc>(
      PREFIX + "classificationResults",
    );
  }

  /**
   * Action: createClassifier (owner, name, labels, instructions?) : (classifierId: ID)
   */
  async createClassifier(
    { owner, name, labels, instructions }: {
      owner: Owner;
      name: string;
      labels: Record<string, unknown>;
      instructions?: string;
    },
  ): Promise<{ classifierId: ID } | { error: string }> {
    if (!name.trim()) {
      return { error: "Name must not be empty" };
    }
    if (!isNonEmptyRecord(labels)) {
      return { error: "Labels must not be empty" };
    }
    const classifierId = freshID();
    await this.classifiers.insertOne({
      _id: classifierId,
      owner,
      name: name.trim(),
      labels,
      instructions,
    });
    return { classifierId };
  }

  /**
   * Action: updateClassifier (classifier, labels?, instructions?) : (ok: Flag)
   */
  async updateClassifier(
    { classifier, labels, instructions }: {
      classifier: Classifier;
      labels?: Record<string, unknown>;
      instructions?: string;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    const existing = await this.classifiers.findOne({ _id: classifier.classifierId });
    if (!existing) {
      return { error: "Classifier not found" };
    }
    const $set: Partial<ClassifierDoc> = {};
    if (labels !== undefined) {
      if (!isNonEmptyRecord(labels)) {
        return { error: "Labels must not be empty" };
      }
      $set.labels = labels;
    }
    if (instructions !== undefined) {
      $set.instructions = instructions;
    }
    if (Object.keys($set).length === 0) {
      return { ok: true };
    }
    await this.classifiers.updateOne({ _id: classifier.classifierId }, { $set });
    return { ok: true };
  }

  /**
   * Action: classify (classifier, item, content) : (classificationResultId?, label?, error?)
   */
  async classify(
    { classifier, item, content }: {
      classifier: Classifier;
      item: Item;
      content: string;
    },
  ): Promise<
    { classificationResultId: ID; label: string } | { error: string }
  > {
    const doc = await this.classifiers.findOne({ _id: classifier.classifierId });
    if (!doc) {
      return { error: "Classifier not found" };
    }
    if (!content.trim()) {
      return { error: "Content must not be empty" };
    }
    const schema = classificationSchema(doc.labels);
    if (!schema) {
      return { error: "Classifier has no valid labels" };
    }
    const c = docToClassifier(doc);
    const labelKeys = Object.keys(doc.labels).join(", ");
    const systemPrompt =
      `You assign exactly one label key from the allowed set: ${labelKeys}. ` +
      `Respond only via the required JSON schema. ` +
      (c.instructions ? `Instructions: ${c.instructions}` : "");
    const userPrompt = `Classify:\n${content.trim()}`;
    try {
      const out = await generateObject<{ label: string }>(
        userPrompt,
        systemPrompt,
        schema,
      );
      const label = out.label;
      if (!Object.prototype.hasOwnProperty.call(doc.labels, label)) {
        return { error: "Model returned a label outside the allowed set" };
      }
      const classificationResultId = freshID();
      await this.classificationResults.insertOne({
        _id: classificationResultId,
        classifierId: classifier.classifierId,
        item,
        label,
        status: "done",
        createdAt: new Date(),
      });
      return { classificationResultId, label };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg };
    }
  }

  /**
   * Action: deleteClassificationResult (classificationResultId) : (ok: Flag)
   */
  async deleteClassificationResult(
    { classificationResultId }: { classificationResultId: ID },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.classificationResults.deleteOne({
      _id: classificationResultId,
    });
    if (res.deletedCount === 0) {
      return { error: "Classification result not found" };
    }
    return { ok: true };
  }

  /**
   * Action: deleteAllClassificationResultsForClassifier (classifier) : (ok: Flag)
   */
  async deleteAllClassificationResultsForClassifier(
    { classifier }: { classifier: Classifier },
  ): Promise<{ ok: boolean } | { error: string }> {
    const exists = await this.classifiers.findOne({ _id: classifier.classifierId });
    if (!exists) {
      return { error: "Classifier not found" };
    }
    await this.classificationResults.deleteMany({
      classifierId: classifier.classifierId,
    });
    return { ok: true };
  }

  /**
   * Action: deleteClassifier (classifierId) : (ok: Flag)
   */
  async deleteClassifier(
    { classifierId }: { classifierId: ID },
  ): Promise<{ ok: boolean } | { error: string }> {
    const existing = await this.classifiers.findOne({ _id: classifierId });
    if (!existing) {
      return { error: "Classifier not found" };
    }
    await this.classificationResults.deleteMany({ classifierId });
    await this.classifiers.deleteOne({ _id: classifierId });
    return { ok: true };
  }

  /**
   * Action: deleteAllClassifiersForOwner (owner) : (ok: Flag)
   */
  async deleteAllClassifiersForOwner(
    { owner }: { owner: Owner },
  ): Promise<{ ok: boolean }> {
    const idDocs = await this.classifiers.find({ owner }, { projection: { _id: 1 } })
      .toArray();
    const ids = idDocs.map((d) => d._id);
    if (ids.length === 0) {
      return { ok: true };
    }
    await this.classificationResults.deleteMany({ classifierId: { $in: ids } });
    await this.classifiers.deleteMany({ owner });
    return { ok: true };
  }

  /**
   * Query: _getLatestClassification (classifier, item) : (classificationResult)
   */
  async _getLatestClassification(
    { classifier, item }: { classifier: Classifier; item: Item },
  ): Promise<{ classificationResult?: ClassificationResult }> {
    const docs = await this.classificationResults.find({
      classifierId: classifier.classifierId,
      item,
    }).sort({ createdAt: -1 }).limit(1).toArray();
    const doc = docs[0];
    if (!doc) {
      return {};
    }
    const classifierDoc = await this.classifiers.findOne({ _id: doc.classifierId });
    if (!classifierDoc) {
      return {};
    }
    return {
      classificationResult: {
        classificationResultId: doc._id,
        classifier: docToClassifier(classifierDoc),
        item: doc.item,
        label: doc.label,
        status: doc.status,
      },
    };
  }

  /**
   * Query: _getItemsByLabel (classifier, label) : (classificationResults)
   */
  async _getItemsByLabel(
    { classifier, label }: { classifier: Classifier; label: string },
  ): Promise<{ classificationResults: ClassificationResult[] }> {
    const docs = await this.classificationResults.find({
      classifierId: classifier.classifierId,
      label,
    }).toArray();
    const classifierDoc = await this.classifiers.findOne({
      _id: classifier.classifierId,
    });
    if (!classifierDoc) {
      return { classificationResults: [] };
    }
    const c = docToClassifier(classifierDoc);
    return {
      classificationResults: docs.map((d) => ({
        classificationResultId: d._id,
        classifier: c,
        item: d.item,
        label: d.label,
        status: d.status,
      })),
    };
  }

  /**
   * Query: _listClassifiersForOwner (owner) : (classifierIds)
   */
  async _listClassifiersForOwner(
    { owner }: { owner: Owner },
  ): Promise<{ classifierIds: ID[] }> {
    const docs = await this.classifiers.find({ owner }, { projection: { _id: 1 } })
      .toArray();
    return { classifierIds: docs.map((d) => d._id) };
  }
}
