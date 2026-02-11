import { Collection, Db } from "npm:mongodb";
import { Empty, ID } from "@utils/types.ts";

const PREFIX = "ProjectLedger.";

// Generic types
export type User = ID;
export type Project = ID;

/**
 * State:
 * a set of Projects with
 *   a project ID
 *   an owner (user ID)
 *   a name String
 *   a description String
 *   a status String (planning|designing|implementing|syncing|assembling|complete|error)
 *   a createdAt DateTime
 *   an updatedAt DateTime
 */
export interface ProjectDoc {
  _id: Project;
  owner: User;
  name: string;
  description: string;
  status:
    | "planning"
    | "designing"
    | "implementing"
    | "syncing"
    | "assembling"
    | "complete"
    | "error"
    | "awaiting_clarification" // Added from sync examples in plan
    | "awaiting_input" // Added from sync examples in plan
    | "implemented"; // Added for implementation completion
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept ProjectLedger
 * @purpose Track which projects belong to which users and their current status.
 */
export default class ProjectLedgerConcept {
  public readonly projects: Collection<ProjectDoc>;

  constructor(private readonly db: Db) {
    this.projects = this.db.collection<ProjectDoc>(PREFIX + "projects");
  }

  /**
   * create (owner: userID, project: projectID, name: String, description: String) : (project: projectID)
   *
   * **requires**: project doesn't exist
   * **effects**: creates project with status="planning", timestamps
   */
  async create({ owner, project, name, description }: {
    owner: User;
    project: Project;
    name: string;
    description: string;
  }): Promise<{ project: Project } | { error: string }> {
    const existing = await this.projects.findOne({ _id: project });
    if (existing) {
      return { error: "Project already exists" };
    }

    const now = new Date();
    const newProject: ProjectDoc = {
      _id: project,
      owner,
      name,
      description,
      status: "planning",
      createdAt: now,
      updatedAt: now,
    };

    await this.projects.insertOne(newProject);
    return { project };
  }

  /**
   * delete (project: projectID) : (ok: Flag)
   * requires: project exists
   * effects: deletes the project
   */
  async delete({ project }: { project: Project }): Promise<Empty | { error: string }> {
    const existing = await this.projects.findOne({ _id: project });
    if (!existing) {
      return { error: "Project does not exist" };
    }
    await this.projects.deleteOne({ _id: project });
    return {};
  }

  /**
   * updateStatus (project: projectID, status: String) : (ok: Flag)
   *
   * **requires**: project exists
   * **effects**: updates status and updatedAt
   */
  async updateStatus({ project, status }: {
    project: Project;
    status: string;
  }): Promise<Empty | { error: string }> {
    const existing = await this.projects.findOne({ _id: project });
    if (!existing) {
      return { error: "Project does not exist" };
    }

    const now = new Date();
    // Default to 'implementing' if no status provided
    const newStatus = status || "planning";

    // Cast status to specific type if strict, but spec says String
    await this.projects.updateOne(
      { _id: project },
      {
        $set: {
          status: newStatus as ProjectDoc["status"],
          updatedAt: now,
        },
      },
    );

    return {};
  }

  /**
   * _getProjects(owner: userID) : (projects: Set<Project>)
   */
  async _getProjects({ owner }: { owner: User }): Promise<Array<{ projects: ProjectDoc[] }>> {
    const projects = await this.projects.find({ owner }).toArray();
    return [{ projects }];
  }

  /**
   * _getProject(project: projectID) : (project: Project) | (error: String)
   */
  async _getProject({ project }: { project: Project }): Promise<Array<{ project: ProjectDoc }> | [{ error: string }]> {
    const p = await this.projects.findOne({ _id: project });
    if (!p) return [{ error: "Project not found" }];
    return [{ project: p }];
  }

  /**
   * _getOwner(project: projectID) : (owner: userID)
   */
  async _getOwner({ project }: { project: Project }): Promise<Array<{ owner: User }>> {
    const p = await this.projects.findOne({ _id: project });
    if (!p) return [];
    return [{ owner: p.owner }];
  }
}
