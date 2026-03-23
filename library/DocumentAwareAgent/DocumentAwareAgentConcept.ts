import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";
import { generateObject, generateText, JSONSchema } from "@utils/ai.ts";

export type Owner = ID;

const PREFIX = "DocumentAwareAgent" + ".";

interface DocumentAwareAgentDoc {
  _id: ID;
  owner: Owner;
  name: string;
  instructions?: string;
  maxContextSize: number;
}

interface DocumentDoc {
  _id: ID;
  documentAwareAgentId: ID;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * @concept DocumentAwareAgent
 * @purpose Support AI agent interactions over a bounded set of in-context documents without full retrieval infrastructure.
 */
export default class DocumentAwareAgentConcept {
  private readonly agents: Collection<DocumentAwareAgentDoc>;
  private readonly documents: Collection<DocumentDoc>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.agents = this.db.collection<DocumentAwareAgentDoc>(PREFIX + "agents");
    this.documents = this.db.collection<DocumentDoc>(PREFIX + "documents");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.agents.createIndex({ owner: 1 }),
      this.documents.createIndex({ documentAwareAgentId: 1 }),
    ]);
    this.indexesCreated = true;
  }

  private contextByteSize(content: string): number {
    return new TextEncoder().encode(content).length;
  }

  private async totalDocumentContextSize(documentAwareAgentId: ID): Promise<number> {
    const docs = await this.documents.find({ documentAwareAgentId }).toArray();
    let total = 0;
    for (const d of docs) {
      total += this.contextByteSize(d.content);
    }
    return total;
  }

  /**
   * Action: createAgent (owner, name, maxContextSize, instructions?) : (documentAwareAgentId)
   */
  async createAgent(
    { owner, name, maxContextSize, instructions }: {
      owner: Owner;
      name: string;
      maxContextSize: number;
      instructions?: string;
    },
  ): Promise<{ documentAwareAgentId: string } | { error: string }> {
    await this.ensureIndexes();
    if (!name.trim()) {
      return { error: "Name must not be empty" };
    }
    if (maxContextSize <= 0) {
      return { error: "maxContextSize must be positive" };
    }

    const documentAwareAgentId = freshID();
    await this.agents.insertOne({
      _id: documentAwareAgentId,
      owner,
      name,
      instructions,
      maxContextSize,
    });

    return { documentAwareAgentId };
  }

  /**
   * Action: renameAgent (documentAwareAgentId, name) : (ok)
   */
  async renameAgent(
    { documentAwareAgentId, name }: { documentAwareAgentId: string; name: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!name.trim()) {
      return { error: "Name must not be empty" };
    }

    const res = await this.agents.updateOne(
      { _id: documentAwareAgentId as ID },
      { $set: { name } },
    );
    if (res.matchedCount === 0) {
      return { error: "Document-aware agent not found" };
    }
    return { ok: true };
  }

  /**
   * Action: updateInstructions (documentAwareAgentId, instructions) : (ok)
   */
  async updateInstructions(
    { documentAwareAgentId, instructions }: { documentAwareAgentId: string; instructions: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.agents.updateOne(
      { _id: documentAwareAgentId as ID },
      { $set: { instructions } },
    );
    if (res.matchedCount === 0) {
      return { error: "Document-aware agent not found" };
    }
    return { ok: true };
  }

  /**
   * Action: addDocument (...) : (documentId?, error?)
   */
  async addDocument(
    { documentAwareAgentId, title, content, metadata }: {
      documentAwareAgentId: string;
      title: string;
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ documentId: string } | { error: string }> {
    await this.ensureIndexes();
    if (!title.trim()) {
      return { error: "Title must not be empty" };
    }
    if (!content.trim()) {
      return { error: "Content must not be empty" };
    }

    const agent = await this.agents.findOne({ _id: documentAwareAgentId as ID });
    if (!agent) {
      return { error: "Document-aware agent not found" };
    }

    const current = await this.totalDocumentContextSize(documentAwareAgentId as ID);
    const addition = this.contextByteSize(content);
    if (current + addition > agent.maxContextSize) {
      return { error: "Would exceed maxContextSize" };
    }

    const documentId = freshID();
    await this.documents.insertOne({
      _id: documentId,
      documentAwareAgentId: documentAwareAgentId as ID,
      title,
      content,
      metadata,
    });

    return { documentId };
  }

  /**
   * Action: deleteDocument (documentId) : (ok)
   */
  async deleteDocument(
    { documentId }: { documentId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.documents.deleteOne({ _id: documentId as ID });
    if (res.deletedCount === 0) {
      return { error: "Document not found" };
    }
    return { ok: true };
  }

  /**
   * Action: deleteAllDocuments (documentAwareAgentId) : (ok)
   */
  async deleteAllDocuments(
    { documentAwareAgentId }: { documentAwareAgentId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const agent = await this.agents.findOne({ _id: documentAwareAgentId as ID });
    if (!agent) {
      return { error: "Document-aware agent not found" };
    }
    await this.documents.deleteMany({ documentAwareAgentId: documentAwareAgentId as ID });
    return { ok: true };
  }

  /**
   * Action: deleteAgent (documentAwareAgentId) : (ok)
   */
  async deleteAgent(
    { documentAwareAgentId }: { documentAwareAgentId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.documents.deleteMany({ documentAwareAgentId: documentAwareAgentId as ID });
    const res = await this.agents.deleteOne({ _id: documentAwareAgentId as ID });
    if (res.deletedCount === 0) {
      return { error: "Document-aware agent not found" };
    }
    return { ok: true };
  }

  /**
   * Action: deleteAllAgentsForOwner (owner) : (ok)
   */
  async deleteAllAgentsForOwner(
    { owner }: { owner: Owner },
  ): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    const agents = await this.agents.find({ owner }).toArray();
    for (const a of agents) {
      await this.documents.deleteMany({ documentAwareAgentId: a._id });
    }
    await this.agents.deleteMany({ owner });
    return { ok: true };
  }

  /**
   * Query: _listAgentsForOwner (owner)
   */
  async _listAgentsForOwner(
    { owner }: { owner: Owner },
  ): Promise<{ documentAwareAgentIds: ID[] }> {
    await this.ensureIndexes();
    const rows = await this.agents.find({ owner }).project<{ _id: ID }>({ _id: 1 }).toArray();
    return { documentAwareAgentIds: rows.map((r) => r._id) };
  }

  /**
   * Query: _getDocuments (documentAwareAgentId)
   */
  async _getDocuments(
    { documentAwareAgentId }: { documentAwareAgentId: string },
  ): Promise<{ documentIds: ID[] } | { error: string }> {
    const agent = await this.agents.findOne({ _id: documentAwareAgentId as ID });
    if (!agent) {
      return { error: "Document-aware agent not found" };
    }
    const docs = await this.documents.find({ documentAwareAgentId: documentAwareAgentId as ID })
      .project<{ _id: ID }>({ _id: 1 }).toArray();
    return { documentIds: docs.map((d) => d._id) };
  }

  private async buildContextPrompt(documentAwareAgentId: string): Promise<string> {
    const agent = await this.agents.findOne({ _id: documentAwareAgentId as ID });
    if (!agent) {
      throw new Error("Document-aware agent not found");
    }
    const docs = await this.documents.find({ documentAwareAgentId: documentAwareAgentId as ID })
      .sort({ title: 1 }).toArray();

    const chunks: string[] = [];
    if (agent.instructions?.trim()) {
      chunks.push(`Instructions: ${agent.instructions.trim()}`);
    }
    for (const d of docs) {
      chunks.push(`${d.title}: ${d.content}`);
    }
    return chunks.join("\n\n");
  }

  /**
   * Query: _answer (documentAwareAgentId, question) : (answer)
   */
  async _answer(
    { documentAwareAgentId, question }: { documentAwareAgentId: string; question: string },
  ): Promise<{ answer: string } | { error: string }> {
    if (!question.trim()) {
      return { error: "Question must not be empty" };
    }
    const agent = await this.agents.findOne({ _id: documentAwareAgentId as ID });
    if (!agent) {
      return { error: "Document-aware agent not found" };
    }

    const context = await this.buildContextPrompt(documentAwareAgentId);
    const system =
      "Answer using only the provided context. If the context is empty, say you have no documents. Be brief.";
    const user = `Context:\n${context}\n\nQuestion:\n${question.trim()}`;

    const answer = await generateText(user, system);
    return { answer: answer.trim() };
  }

  /**
   * Query: _answerStructured (documentAwareAgentId, question, schema) : (answerJson)
   */
  async _answerStructured(
    { documentAwareAgentId, question, schema }: {
      documentAwareAgentId: string;
      question: string;
      schema: JSONSchema;
    },
  ): Promise<{ answerJson: Record<string, unknown> } | { error: string }> {
    if (!question.trim()) {
      return { error: "Question must not be empty" };
    }
    if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
      return { error: "Schema must not be empty" };
    }

    const agent = await this.agents.findOne({ _id: documentAwareAgentId as ID });
    if (!agent) {
      return { error: "Document-aware agent not found" };
    }

    const context = await this.buildContextPrompt(documentAwareAgentId);
    const system =
      "Respond with structured data matching the schema. Use only information from the context; if unknown, use null or empty arrays as appropriate.";
    const user = `Context:\n${context}\n\nQuestion:\n${question.trim()}`;

    const answerJson = await generateObject<Record<string, unknown>>(user, system, schema);
    return { answerJson };
  }
}
