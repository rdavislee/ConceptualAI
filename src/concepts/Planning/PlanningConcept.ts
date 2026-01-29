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
   * helper to call the Python DSPy script
   */
  private async callPlanner(action: "initiate" | "clarify" | "modify", payload: any): Promise<{
    status: string;
    plan?: Record<string, any>;
    questions?: string[];
    error?: string;
  }> {
    try {
        const pythonCmd = Deno.build.os === "windows" ? "python" : "python3";
        const scriptPath = "src/concepts/Planning/dspy/main.py";

        const command = new Deno.Command(pythonCmd, {
            args: [scriptPath],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped", // Capture stderr for debugging
            env: {
                "PYTHONDONTWRITEBYTECODE": "1"
            }
        });

        const process = command.spawn();
        const writer = process.stdin.getWriter();
        
        // Send request
        await writer.write(new TextEncoder().encode(JSON.stringify({ action, payload })));
        await writer.close();

        // Get output
        const { stdout, stderr, success } = await process.output();
        const outputStr = new TextDecoder().decode(stdout);
        const errorStr = new TextDecoder().decode(stderr);

        if (!success) {
            console.error("DSPy script failed:", errorStr);
            return { status: "error", error: "Internal planner script error" };
        }

        try {
            const result = JSON.parse(outputStr);
            if (result.error) {
                console.error("DSPy script returned error:", result.error);
                return { status: "error", error: result.error };
            }
            return result;
        } catch (e) {
            console.error("Failed to parse DSPy output:", outputStr);
            console.error("Stderr:", errorStr);
            return { status: "error", error: "Invalid response from planner" };
        }

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
    const result = await this.callPlanner("initiate", {
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
    const newClarifications = existing.clarifications || [];
    for (const [q, a] of Object.entries(answers)) {
      newClarifications.push({ question: q, answer: String(a) });
    }

    // Call DSPy agent with history
    const result = await this.callPlanner("clarify", {
      original_description: existing.description,
      answers,
      previous_clarifications: existing.clarifications, // Pass old history, agent will append new answers for context
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
   * modify (project: projectID, feedback: String) : (project: projectID, status: String, plan: Object)
   *
   * **requires**: plan exists with status="complete" (or previously complete)
   * **effects**: calls DSPy planner with current plan and feedback to generate a new plan
   */
  async modify({ project, feedback }: {
    project: Project;
    feedback: string;
  }): Promise<{
    project: Project;
    status: string;
    plan: Record<string, any>;
    feedback: string;
  } | { error: string }> {
    const existing = await this.plans.findOne({ _id: project });
    if (!existing) {
      return { error: "Plan does not exist" };
    }
    if (!existing.plan) {
        return { error: "Plan has not been generated yet" };
    }

    // Call DSPy agent
    const result = await this.callPlanner("modify", {
      current_plan: existing.plan,
      feedback,
    });

    if (result.status === "error" || !result.plan) {
        return { error: result.error || "Failed to modify plan" };
    }

    const update: Partial<PlanDoc> = {
      status: "complete", // Status remains complete after modification
      plan: result.plan,
      // We could track modification history here if needed
    };

    await this.plans.updateOne(
      { _id: project },
      { $set: update },
    );

    return {
      project,
      status: "complete",
      plan: update.plan!,
      feedback,
    };
  }

  /**
   * delete (project: projectID) : (ok: Flag)
   * requires: plan exists
   * effects: deletes the plan
   */
  async delete({ project }: { project: Project }): Promise<Empty | { error: string }> {
    const existing = await this.plans.findOne({ _id: project });
    if (!existing) {
      return { error: "Plan does not exist" };
    }
    await this.plans.deleteOne({ _id: project });
    return {};
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
