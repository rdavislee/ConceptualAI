import { Collection, Db } from "npm:mongodb";
import { Empty, ID } from "@utils/types.ts";

const PREFIX = "Planning.";

// Generic types
type Project = ID;

/**
 * State:
 * a set of Plans with
 *   a project ID
 *   a description String
 *   an optional plan Object
 *   an optional questions Array<String>
 *   a status String (processing|needs_clarification|complete|error)
 *   a clarifications Array<Object> (history of Q&A)
 *   a createdAt DateTime
 */
export interface PlanDoc {
  _id: Project;
  description: string;
  plan?: Record<string, any>;
  questions?: string[];
  status: "processing" | "needs_clarification" | "complete" | "error";
  clarifications: Array<{ question: string; answer: string }>;
  createdAt: Date;
}

// Configuration for the Python DSPy service
const DSPY_SERVICE_URL = Deno.env.get("DSPY_PLANNING_URL") || "http://localhost:8001";

/**
 * @concept Planning
 * @purpose Generate an app plan from a description, asking clarifying questions when needed.
 */
export default class PlanningConcept {
  public readonly plans: Collection<PlanDoc>;

  constructor(private readonly db: Db) {
    this.plans = this.db.collection<PlanDoc>(PREFIX + "plans");
  }

  /**
   * Helper to call the Python DSPy service
   */
  private async callPlanner(endpoint: string, body: any): Promise<{
    status: string;
    plan?: Record<string, any>;
    questions?: string[];
  }> {
    try {
      const response = await fetch(`${DSPY_SERVICE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`DSPy service error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error("Failed to call DSPy planner:", error);
      return { status: "error" };
    }
  }

  /**
   * initiate (project: projectID, description: String) : (project: projectID, status: String, plan?: Object, questions?: Array<String>)
   *
   * **requires**: no plan exists for project
   * **effects**: calls DSPy planner, stores result
   */
  async initiate({ project, description }: {
    project: Project;
    description: string;
  }): Promise<{
    project: Project;
    status: string;
    plan?: Record<string, any>;
    questions?: string[];
  } | { error: string }> {
    const existing = await this.plans.findOne({ _id: project });
    if (existing) {
      return { error: "Plan already exists for project" };
    }

    // Call DSPy agent
    const result = await this.callPlanner("/initiate", {
      project_id: project,
      description,
    });

    const doc: PlanDoc = {
      _id: project,
      description,
      status: result.status as PlanDoc["status"],
      clarifications: [],
      createdAt: new Date(),
    };

    if (result.plan) doc.plan = result.plan;
    if (result.questions) doc.questions = result.questions;

    await this.plans.insertOne(doc);

    return {
      project,
      status: doc.status,
      plan: doc.plan,
      questions: doc.questions,
    };
  }

  /**
   * clarify (project: projectID, answers: Object) : (project: projectID, status: String, plan?: Object, questions?: Array<String>)
   *
   * **requires**: plan exists with status="needs_clarification"
   * **effects**: adds to clarifications, re-runs planner with context
   */
  async clarify({ project, answers }: {
    project: Project;
    answers: Record<string, string>;
  }): Promise<{
    project: Project;
    status: string;
    plan?: Record<string, any>;
    questions?: string[];
  } | { error: string }> {
    const existing = await this.plans.findOne({ _id: project });
    if (!existing) {
      return { error: "Plan does not exist" };
    }
    if (existing.status !== "needs_clarification") {
      return { error: "Plan does not need clarification" };
    }

    // Update clarifications history
    // We assume answers is a map of Question -> Answer, or just matching indices?
    // The spec says "answers: Object". Let's assume it maps question text to answer text
    // or we just append the new Q&A pairs.
    // Ideally we should know WHICH questions we are answering.
    // For now, let's treat answers as { [question]: answer }

    const newClarifications = existing.clarifications || [];
    for (const [q, a] of Object.entries(answers)) {
      newClarifications.push({ question: q, answer: String(a) });
    }

    // Call DSPy agent with history
    const result = await this.callPlanner("/clarify", {
      project_id: project,
      answers,
      previous_clarifications: newClarifications,
      original_description: existing.description,
    });

    const update: Partial<PlanDoc> = {
      status: result.status as PlanDoc["status"],
      clarifications: newClarifications,
    };

    if (result.plan) update.plan = result.plan;
    if (result.questions) update.questions = result.questions;

    await this.plans.updateOne(
      { _id: project },
      { $set: update },
    );

    return {
      project,
      status: update.status!,
      plan: update.plan,
      questions: update.questions,
    };
  }

  /**
   * _getPlan(project: projectID) : (plan: Plan)
   */
  async _getPlan({ project }: { project: Project }): Promise<Array<{ plan: PlanDoc }>> {
    const doc = await this.plans.findOne({ _id: project });
    if (!doc) return [];
    return [{ plan: doc }];
  }

  /**
   * _getStatus(project: projectID) : (status: String)
   */
  async _getStatus({ project }: { project: Project }): Promise<Array<{ status: string }>> {
    const doc = await this.plans.findOne({ _id: project });
    if (!doc) return [];
    return [{ status: doc.status }];
  }
}

