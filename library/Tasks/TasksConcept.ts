import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

/**
 * @concept Tasks
 * @purpose To track units of work, their current status, and who is responsible for them.
 */
export type Assignee = ID;
export type Creator = ID;
export type Item = ID;

const PREFIX = "Tasks" + ".";

const STATUSES = ["To Do", "In Progress", "Done", "On Hold"] as const;
export type TaskStatus = typeof STATUSES[number];

interface TaskState {
  _id: ID;
  creator: Creator;
  assignee: Assignee;
  item: Item | null;
  parent: ID | null; // Parent Task ID
  title: string;
  description: string;
  status: TaskStatus;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export default class TasksConcept {
  private readonly tasks: Collection<TaskState>;

  constructor(private readonly db: Db) {
    this.tasks = this.db.collection<TaskState>(PREFIX + "tasks");
  }

  async ensureIndexes(): Promise<void> {
    await this.tasks.createIndex({ assignee: 1, createdAt: -1 });
    await this.tasks.createIndex({ creator: 1, createdAt: -1 });
    await this.tasks.createIndex({ item: 1, createdAt: -1 });
    await this.tasks.createIndex({ parent: 1, createdAt: -1 });
  }

  /**
   * Action: createTask (creator: Creator, assignee: Assignee, title: String, description: String, dueDate?: DateTime, item?: Item, parent?: string) : (taskId: ID)
   */
  async createTask(
    { creator, assignee, title, description, dueDate, item, parent }: {
      creator: Creator;
      assignee: Assignee;
      title: string;
      description: string;
      dueDate?: Date;
      item?: Item;
      parent?: string;
    },
  ): Promise<{ taskId: string } | { error: string }> {
    if (!title || title.trim().length === 0) {
      return { error: "Task title cannot be empty" };
    }

    const now = new Date();
    const taskId = freshID();
    await this.tasks.insertOne({
      _id: taskId,
      creator,
      assignee,
      item: item ?? null,
      parent: (parent as ID) ?? null,
      title,
      description: description ?? "",
      status: "To Do",
      dueDate: dueDate ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return { taskId };
  }

  /**
   * Action: updateDetails (taskId: ID, title?: String, description?: String, dueDate?: DateTime) : (ok: Flag)
   */
  async updateDetails(
    { taskId, title, description, dueDate }: {
      taskId: string;
      title?: string;
      description?: string;
      dueDate?: Date;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    const update: Partial<Pick<TaskState, "title" | "description" | "dueDate" | "updatedAt">> = { 
      updatedAt: new Date() 
    };
    if (title !== undefined) {
      if (title.trim().length === 0) return { error: "Title cannot be empty" };
      update.title = title;
    }
    if (description !== undefined) update.description = description;
    if (dueDate !== undefined) update.dueDate = dueDate;

    const res = await this.tasks.updateOne({ _id: taskId as ID }, { $set: update });
    if (res.matchedCount === 0) {
      return { error: "Task not found" };
    }

    return { ok: true };
  }

  /**
   * Action: updateStatus (taskId: ID, status: String) : (ok: Flag)
   */
  async updateStatus(
    { taskId, status }: { taskId: string; status: TaskStatus },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!STATUSES.includes(status)) {
      return { error: `Invalid status. Must be one of: ${STATUSES.join(", ")}` };
    }

    const res = await this.tasks.updateOne(
      { _id: taskId as ID },
      { $set: { status, updatedAt: new Date() } },
    );

    if (res.matchedCount === 0) {
      return { error: "Task not found" };
    }

    return { ok: true };
  }

  /**
   * Action: assign (taskId: ID, assignee: Assignee) : (ok: Flag)
   */
  async assign(
    { taskId, assignee }: { taskId: string; assignee: Assignee },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.tasks.updateOne(
      { _id: taskId as ID },
      { $set: { assignee, updatedAt: new Date() } },
    );

    if (res.matchedCount === 0) {
      return { error: "Task not found" };
    }

    return { ok: true };
  }

  /**
   * Cleanup: deleteByCreator (creator) - removes all tasks created by user (e.g. account deletion).
   */
  async deleteByCreator({ creator }: { creator: Creator }): Promise<{ ok: boolean }> {
    await this.tasks.deleteMany({ creator });
    return { ok: true };
  }

  /**
   * Cleanup: deleteByAssignee (assignee) - removes all tasks assigned to user (e.g. account deletion).
   */
  async deleteByAssignee({ assignee }: { assignee: Assignee }): Promise<{ ok: boolean }> {
    await this.tasks.deleteMany({ assignee });
    return { ok: true };
  }

  /**
   * Cleanup: deleteByItem (item) - removes all tasks associated with item (e.g. item deletion).
   */
  async deleteByItem({ item }: { item: Item }): Promise<{ ok: boolean }> {
    await this.tasks.deleteMany({ item });
    return { ok: true };
  }

  /**
   * Cleanup: deleteByParent (parent) - removes all subtasks of a parent (cascade for parent deletion).
   */
  async deleteByParent({ parent }: { parent: string }): Promise<{ ok: boolean }> {
    await this.tasks.deleteMany({ parent: parent as ID });
    return { ok: true };
  }

  /**
   * Action: deleteTask (taskId: ID) : (ok: Flag)
   */
  async deleteTask(
    { taskId }: { taskId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.tasks.deleteOne({ _id: taskId as ID });
    if (res.deletedCount === 0) {
      return { error: "Task not found" };
    }

    return { ok: true };
  }

  /**
   * Query: _getTask (taskId: ID) : (task: Task?)
   */
  async _getTask(
    { taskId }: { taskId: string },
  ): Promise<Array<{ task: TaskState | null }>> {
    const task = await this.tasks.findOne({ _id: taskId as ID });
    return [{ task }];
  }

  /**
   * Query: _getTasksByAssignee (assignee: Assignee) : (tasks: Set<Task>)
   */
  async _getTasksByAssignee(
    { assignee }: { assignee: Assignee },
  ): Promise<Array<{ tasks: TaskState[] }>> {
    const tasks = await this.tasks.find({ assignee }).sort({ createdAt: -1 }).toArray();
    return [{ tasks }];
  }

  /**
   * Query: _getTasksByCreator (creator: Creator) : (tasks: Set<Task>)
   */
  async _getTasksByCreator(
    { creator }: { creator: Creator },
  ): Promise<Array<{ tasks: TaskState[] }>> {
    const tasks = await this.tasks.find({ creator }).sort({ createdAt: -1 }).toArray();
    return [{ tasks }];
  }

  /**
   * Query: _getTasksByItem (item: Item) : (tasks: Set<Task>)
   */
  async _getTasksByItem(
    { item }: { item: Item },
  ): Promise<Array<{ tasks: TaskState[] }>> {
    const tasks = await this.tasks.find({ item }).sort({ createdAt: -1 }).toArray();
    return [{ tasks }];
  }

  /**
   * Query: _getProjects () : (projects: Set<Task>)
   */
  async _getProjects(): Promise<Array<{ projects: TaskState[] }>> {
    const projects = await this.tasks.find({ parent: null }).sort({ createdAt: -1 }).toArray();
    return [{ projects }];
  }

  /**
   * Query: _getSubtasks (parent: Task) : (tasks: Set<Task>)
   */
  async _getSubtasks(
    { parent }: { parent: string },
  ): Promise<Array<{ tasks: TaskState[] }>> {
    const tasks = await this.tasks.find({ parent: parent as ID }).sort({ createdAt: -1 }).toArray();
    return [{ tasks }];
  }
}
