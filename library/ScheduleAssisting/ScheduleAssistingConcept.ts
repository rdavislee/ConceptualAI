import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";
import { generateObject, JSONSchema } from "@utils/ai.ts";

export type User = ID;

const PREFIX = "ScheduleAssisting" + ".";

const AGENT_STATUSES = ["idle", "busy"] as const;
type AgentStatus = typeof AGENT_STATUSES[number];

interface SchedulingAgentDoc {
  _id: ID;
  owner: User;
  systemPrompt: string;
  status: AgentStatus;
}

interface DayDoc {
  _id: ID;
  schedulingAgentId: ID;
  date: Date;
  data: Record<string, unknown>;
}

/** Query shape: a day associated with a scheduling agent (spec: Day). */
export interface Day {
  dayId: ID;
  schedulingAgentId: ID;
  date: Date;
  data: Record<string, unknown>;
}

function dayDocToDay(doc: DayDoc): Day {
  return {
    dayId: doc._id,
    schedulingAgentId: doc.schedulingAgentId,
    date: doc.date,
    data: doc.data,
  };
}

interface ScheduleChangeResult {
  updates: Array<{ dayId: string; data: Record<string, unknown> }>;
}

const SCHEDULE_CHANGE_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    updates: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          dayId: { type: "string" },
          data: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["dayId", "data"],
      },
    },
  },
  required: ["updates"],
};

/**
 * @concept ScheduleAssisting
 * @purpose AI-assisted schedule management with day-level data updated from natural-language requests.
 */
export default class ScheduleAssistingConcept {
  private readonly agents: Collection<SchedulingAgentDoc>;
  private readonly days: Collection<DayDoc>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.agents = this.db.collection<SchedulingAgentDoc>(PREFIX + "agents");
    this.days = this.db.collection<DayDoc>(PREFIX + "days");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.agents.createIndex({ owner: 1 }),
      this.days.createIndex({ schedulingAgentId: 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: createSchedulingAgent (owner, systemPrompt) : (schedulingAgentId)
   */
  async createSchedulingAgent(
    { owner, systemPrompt }: { owner: User; systemPrompt: string },
  ): Promise<{ schedulingAgentId: string } | { error: string }> {
    await this.ensureIndexes();
    if (!systemPrompt.trim()) {
      return { error: "systemPrompt must not be empty" };
    }

    const schedulingAgentId = freshID();
    await this.agents.insertOne({
      _id: schedulingAgentId,
      owner,
      systemPrompt,
      status: "idle",
    });

    return { schedulingAgentId };
  }

  /**
   * Action: setSystemPrompt (schedulingAgentId, systemPrompt) : (ok)
   */
  async setSystemPrompt(
    { schedulingAgentId, systemPrompt }: { schedulingAgentId: string; systemPrompt: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (!systemPrompt.trim()) {
      return { error: "systemPrompt must not be empty" };
    }
    const res = await this.agents.updateOne(
      { _id: schedulingAgentId as ID },
      { $set: { systemPrompt } },
    );
    if (res.matchedCount === 0) {
      return { error: "Scheduling agent not found" };
    }
    return { ok: true };
  }

  /**
   * Action: createDay (schedulingAgentId, date, data) : (dayId)
   */
  async createDay(
    { schedulingAgentId, date, data }: {
      schedulingAgentId: string;
      date: Date;
      data: Record<string, unknown>;
    },
  ): Promise<{ dayId: string } | { error: string }> {
    await this.ensureIndexes();
    const agent = await this.agents.findOne({ _id: schedulingAgentId as ID });
    if (!agent) {
      return { error: "Scheduling agent not found" };
    }

    const dayId = freshID();
    await this.days.insertOne({
      _id: dayId,
      schedulingAgentId: schedulingAgentId as ID,
      date,
      data,
    });

    return { dayId };
  }

  /**
   * Action: updateDay (dayId, data) : (ok)
   */
  async updateDay(
    { dayId, data }: { dayId: string; data: Record<string, unknown> },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.days.updateOne(
      { _id: dayId as ID },
      { $set: { data } },
    );
    if (res.matchedCount === 0) {
      return { error: "Day not found" };
    }
    return { ok: true };
  }

  /**
   * Action: deleteDay (dayId) : (ok)
   */
  async deleteDay(
    { dayId }: { dayId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.days.deleteOne({ _id: dayId as ID });
    if (res.deletedCount === 0) {
      return { error: "Day not found" };
    }
    return { ok: true };
  }

  /**
   * Action: deleteAllDaysForAgent (schedulingAgentId) : (ok)
   */
  async deleteAllDaysForAgent(
    { schedulingAgentId }: { schedulingAgentId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const agent = await this.agents.findOne({ _id: schedulingAgentId as ID });
    if (!agent) {
      return { error: "Scheduling agent not found" };
    }
    await this.days.deleteMany({ schedulingAgentId: schedulingAgentId as ID });
    return { ok: true };
  }

  /**
   * Action: requestScheduleChange (schedulingAgentId, request) : (ok?, error?)
   */
  async requestScheduleChange(
    { schedulingAgentId, request }: { schedulingAgentId: string; request: string },
  ): Promise<{ ok: true } | { error: string }> {
    await this.ensureIndexes();
    if (!request.trim()) {
      return { error: "Request must not be empty" };
    }

    const agent = await this.agents.findOne({ _id: schedulingAgentId as ID });
    if (!agent) {
      return { error: "Scheduling agent not found" };
    }
    if (agent.status !== "idle") {
      return { error: "Agent is not idle" };
    }

    await this.agents.updateOne(
      { _id: schedulingAgentId as ID },
      { $set: { status: "busy" } },
    );

    try {
      const dayRows = await this.days.find({ schedulingAgentId: schedulingAgentId as ID }).toArray();
      if (dayRows.length === 0) {
        return { ok: true };
      }

      const snapshot = dayRows.map((d) => ({
        dayId: d._id,
        date: d.date.toISOString().slice(0, 10),
        data: d.data,
      }));

      const ids = snapshot.map((s) => s.dayId).join(", ");
      const userPrompt =
        `Request: ${request.trim()}\n` +
        `Valid dayId values (copy exactly): ${ids}\n` +
        `Days (JSON): ${JSON.stringify(snapshot)}\n` +
        "Return updates: each item replaces that day's entire data. dayId must match one of the valid values.";

      const systemPrompt =
        `${agent.systemPrompt}\n\n` +
        "Apply the minimum changes needed. Always return at least one update when the request implies a schedule change. " +
        "dayId must be copied exactly from Valid dayId values. Output JSON only via the schema.";

      const parsed = await generateObject<ScheduleChangeResult>(
        userPrompt,
        systemPrompt,
        SCHEDULE_CHANGE_SCHEMA,
      );

      for (const u of parsed.updates ?? []) {
        const id = u.dayId as string;
        const row = await this.days.findOne({
          _id: id as ID,
          schedulingAgentId: schedulingAgentId as ID,
        });
        if (!row) continue;
        await this.days.updateOne(
          { _id: id as ID },
          { $set: { data: u.data ?? {} } },
        );
      }

      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: message };
    } finally {
      await this.agents.updateOne(
        { _id: schedulingAgentId as ID },
        { $set: { status: "idle" } },
      );
    }
  }

  /**
   * Action: deleteSchedulingAgent (schedulingAgentId) : (ok)
   */
  async deleteSchedulingAgent(
    { schedulingAgentId }: { schedulingAgentId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.days.deleteMany({ schedulingAgentId: schedulingAgentId as ID });
    const res = await this.agents.deleteOne({ _id: schedulingAgentId as ID });
    if (res.deletedCount === 0) {
      return { error: "Scheduling agent not found" };
    }
    return { ok: true };
  }

  /**
   * Action: deleteAllSchedulingAgentsForOwner (owner) : (ok)
   */
  async deleteAllSchedulingAgentsForOwner(
    { owner }: { owner: User },
  ): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    const agents = await this.agents.find({ owner }).toArray();
    for (const a of agents) {
      await this.days.deleteMany({ schedulingAgentId: a._id });
    }
    await this.agents.deleteMany({ owner });
    return { ok: true };
  }

  /**
   * Query: _listSchedulingAgentsForOwner (owner)
   */
  async _listSchedulingAgentsForOwner(
    { owner }: { owner: User },
  ): Promise<{ schedulingAgentIds: ID[] }> {
    await this.ensureIndexes();
    const rows = await this.agents.find({ owner }).project<{ _id: ID }>({ _id: 1 }).toArray();
    return { schedulingAgentIds: rows.map((r) => r._id) };
  }

  /**
   * Query: _getDay (dayId) : (day)
   */
  async _getDay(
    { dayId }: { dayId: string },
  ): Promise<{ day: Day } | { error: string }> {
    const doc = await this.days.findOne({ _id: dayId as ID });
    if (!doc) {
      return { error: "Day not found" };
    }
    return { day: dayDocToDay(doc) };
  }

  /**
   * Query: _listDaysForAgent (schedulingAgentId)
   */
  async _listDaysForAgent(
    { schedulingAgentId }: { schedulingAgentId: string },
  ): Promise<{ dayIds: ID[] } | { error: string }> {
    const agent = await this.agents.findOne({ _id: schedulingAgentId as ID });
    if (!agent) {
      return { error: "Scheduling agent not found" };
    }
    const rows = await this.days.find({ schedulingAgentId: schedulingAgentId as ID })
      .project<{ _id: ID }>({ _id: 1 }).toArray();
    return { dayIds: rows.map((r) => r._id) };
  }
}
