import { Collection, Db } from "npm:mongodb";
import { generateObject, JSONSchema } from "@utils/ai.ts";
import { freshID } from "@utils/database.ts";
import { ID } from "@utils/types.ts";

export type Owner = ID;
export type Item = ID;

const PREFIX = "AIModeration" + ".";

const MODERATION_OUTPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    verdict: { type: "boolean", description: "true if content passes the policy" },
    rationale: { type: "string", description: "Brief reason" },
  },
  required: ["verdict", "rationale"],
  additionalProperties: false,
};

export interface ModerationPolicy {
  moderationPolicyId: ID;
  owner: Owner;
  name: string;
  policyText: string;
}

export interface ModerationResult {
  moderationResultId: ID;
  policy: ModerationPolicy;
  item: Item;
  verdict?: boolean;
  rationale?: string;
  status: string;
}

interface PolicyDoc {
  _id: ID;
  owner: Owner;
  name: string;
  policyText: string;
}

interface ModerationResultDoc {
  _id: ID;
  policyId: ID;
  item: Item;
  verdict?: boolean;
  rationale?: string;
  status: string;
  createdAt: Date;
}

function docToPolicy(doc: PolicyDoc): ModerationPolicy {
  return {
    moderationPolicyId: doc._id,
    owner: doc.owner,
    name: doc.name,
    policyText: doc.policyText,
  };
}

function isNonEmptyContent(content: Record<string, unknown>): boolean {
  return Object.keys(content).length > 0;
}

/**
 * @concept AIModeration
 * @purpose Screen content against policies and persist moderation decisions.
 */
export default class AIModerationConcept {
  policies: Collection<PolicyDoc>;
  moderationResults: Collection<ModerationResultDoc>;

  constructor(private readonly db: Db) {
    this.policies = this.db.collection<PolicyDoc>(PREFIX + "policies");
    this.moderationResults = this.db.collection<ModerationResultDoc>(
      PREFIX + "moderationResults",
    );
  }

  async createPolicy(
    { owner, name, policyText }: {
      owner: Owner;
      name: string;
      policyText: string;
    },
  ): Promise<{ moderationPolicyId: ID } | { error: string }> {
    if (!name.trim()) {
      return { error: "Name must not be empty" };
    }
    if (!policyText.trim()) {
      return { error: "Policy text must not be empty" };
    }
    const moderationPolicyId = freshID();
    await this.policies.insertOne({
      _id: moderationPolicyId,
      owner,
      name: name.trim(),
      policyText: policyText.trim(),
    });
    return { moderationPolicyId };
  }

  async moderate(
    { policy, item, content }: {
      policy: ModerationPolicy;
      item: Item;
      content: Record<string, unknown>;
    },
  ): Promise<
    | { moderationResultId: ID; verdict: boolean; rationale?: string }
    | { error: string }
  > {
    const policyDoc = await this.policies.findOne({ _id: policy.moderationPolicyId });
    if (!policyDoc) {
      return { error: "Policy not found" };
    }
    if (!isNonEmptyContent(content)) {
      return { error: "Content must not be empty" };
    }
    const p = docToPolicy(policyDoc);
    const systemPrompt =
      `You moderate content against this policy:\n${p.policyText}\n` +
      `Return verdict true only if the content clearly passes; false if it violates or is unsafe.`;
    const userPrompt = `Content (JSON):\n${JSON.stringify(content)}`;
    try {
      const out = await generateObject<{ verdict: boolean; rationale: string }>(
        userPrompt,
        systemPrompt,
        MODERATION_OUTPUT_SCHEMA,
      );
      const moderationResultId = freshID();
      await this.moderationResults.insertOne({
        _id: moderationResultId,
        policyId: policy.moderationPolicyId,
        item,
        verdict: out.verdict,
        rationale: out.rationale,
        status: "done",
        createdAt: new Date(),
      });
      return {
        moderationResultId,
        verdict: out.verdict,
        rationale: out.rationale,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg };
    }
  }

  async deleteModerationResult(
    { moderationResultId }: { moderationResultId: ID },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.moderationResults.deleteOne({ _id: moderationResultId });
    if (res.deletedCount === 0) {
      return { error: "Moderation result not found" };
    }
    return { ok: true };
  }

  async deleteAllModerationResultsForPolicy(
    { policy }: { policy: ModerationPolicy },
  ): Promise<{ ok: boolean } | { error: string }> {
    const exists = await this.policies.findOne({ _id: policy.moderationPolicyId });
    if (!exists) {
      return { error: "Policy not found" };
    }
    await this.moderationResults.deleteMany({ policyId: policy.moderationPolicyId });
    return { ok: true };
  }

  async deletePolicy(
    { moderationPolicyId }: { moderationPolicyId: ID },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.policies.deleteOne({ _id: moderationPolicyId });
    if (res.deletedCount === 0) {
      return { error: "Policy not found" };
    }
    await this.moderationResults.deleteMany({ policyId: moderationPolicyId });
    return { ok: true };
  }

  async deleteAllPoliciesForOwner(
    { owner }: { owner: Owner },
  ): Promise<{ ok: boolean }> {
    const idDocs = await this.policies.find({ owner }, { projection: { _id: 1 } })
      .toArray();
    const ids = idDocs.map((d) => d._id);
    if (ids.length === 0) {
      return { ok: true };
    }
    await this.moderationResults.deleteMany({ policyId: { $in: ids } });
    await this.policies.deleteMany({ owner });
    return { ok: true };
  }

  async _getLatestModeration(
    { policy, item }: { policy: ModerationPolicy; item: Item },
  ): Promise<{ moderationResult?: ModerationResult }> {
    const docs = await this.moderationResults.find({
      policyId: policy.moderationPolicyId,
      item,
    }).sort({ createdAt: -1 }).limit(1).toArray();
    const doc = docs[0];
    if (!doc) {
      return {};
    }
    const policyDoc = await this.policies.findOne({ _id: doc.policyId });
    if (!policyDoc) {
      return {};
    }
    return {
      moderationResult: {
        moderationResultId: doc._id,
        policy: docToPolicy(policyDoc),
        item: doc.item,
        verdict: doc.verdict,
        rationale: doc.rationale,
        status: doc.status,
      },
    };
  }

  async _getFlaggedItems(
    { policy }: { policy: ModerationPolicy },
  ): Promise<{ moderationResults: ModerationResult[] }> {
    const policyDoc = await this.policies.findOne({ _id: policy.moderationPolicyId });
    if (!policyDoc) {
      return { moderationResults: [] };
    }
    const p = docToPolicy(policyDoc);
    const docs = await this.moderationResults.find({
      policyId: policy.moderationPolicyId,
      verdict: false,
    }).toArray();
    return {
      moderationResults: docs.map((d) => ({
        moderationResultId: d._id,
        policy: p,
        item: d.item,
        verdict: d.verdict,
        rationale: d.rationale,
        status: d.status,
      })),
    };
  }

  async _listPoliciesForOwner(
    { owner }: { owner: Owner },
  ): Promise<{ moderationPolicyIds: ID[] }> {
    const docs = await this.policies.find({ owner }, { projection: { _id: 1 } })
      .toArray();
    return { moderationPolicyIds: docs.map((d) => d._id) };
  }
}
