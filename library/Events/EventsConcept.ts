import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

/**
 * @concept Events
 * @purpose Manage a personal timeline of scheduled activities.
 */
export type Owner = ID;

const PREFIX = "Events" + ".";

interface EventState {
  _id: ID;
  owner: Owner;
  title: string;
  description: string;
  startTime: Date;
  endTime: Date;
}

export default class EventsConcept {
  private readonly events: Collection<EventState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.events = this.db.collection<EventState>(PREFIX + "events");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.events.createIndex({ owner: 1, startTime: 1, endTime: 1 });
    this.indexesCreated = true;
  }

  /**
   * Lifecycle: deleteByOwner (owner: Owner) : (ok: Flag)
   * Deletes all events for the given owner. Use when owner account is deleted.
   */
  async deleteByOwner({ owner }: { owner: Owner }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.events.deleteMany({ owner });
    return { ok: true };
  }

  /**
   * Action: createEvent (owner: Owner, title: String, startTime: DateTime, endTime: DateTime, description: String) : (eventId: ID)
   */
  async createEvent(
    { owner, title, startTime, endTime, description }: {
      owner: Owner;
      title: string;
      startTime: Date;
      endTime: Date;
      description: string;
    },
  ): Promise<{ eventId: string } | { error: string }> {
    if (startTime >= endTime) {
      return { error: "endTime must be after startTime" };
    }

    await this.ensureIndexes();
    const eventId = freshID();
    await this.events.insertOne({
      _id: eventId,
      owner,
      title,
      startTime,
      endTime,
      description,
    });

    return { eventId };
  }

  /**
   * Action: updateEvent (eventId: ID, owner?: Owner, title?: String, startTime?: DateTime, endTime?: DateTime, description?: String) : (ok: Flag)
   * If owner is provided, verifies the actor owns the event before updating.
   */
  async updateEvent(
    { eventId, owner, title, startTime, endTime, description }: {
      eventId: string;
      owner?: Owner;
      title?: string;
      startTime?: Date;
      endTime?: Date;
      description?: string;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    const existing = await this.events.findOne({ _id: eventId as ID });
    if (!existing) {
      return { error: "Event not found" };
    }
    if (owner !== undefined && existing.owner !== owner) {
      return { error: "Not authorized to update this event" };
    }

    const newStart = startTime ?? existing.startTime;
    const newEnd = endTime ?? existing.endTime;

    if (newStart >= newEnd) {
      return { error: "endTime must be after startTime" };
    }

    const update: any = {};
    if (title !== undefined) update.title = title;
    if (startTime !== undefined) update.startTime = startTime;
    if (endTime !== undefined) update.endTime = endTime;
    if (description !== undefined) update.description = description;

    if (Object.keys(update).length === 0) {
      return { error: "At least one field must be provided for update" };
    }

    await this.events.updateOne({ _id: eventId as ID }, { $set: update });
    return { ok: true };
  }

  /**
   * Action: deleteEvent (eventId: ID, owner?: Owner) : (ok: Flag)
   * If owner is provided, verifies the actor owns the event before deleting.
   */
  async deleteEvent(
    { eventId, owner }: { eventId: string; owner?: Owner },
  ): Promise<{ ok: boolean } | { error: string }> {
    const existing = await this.events.findOne({ _id: eventId as ID });
    if (!existing) {
      return { error: "Event not found" };
    }
    if (owner !== undefined && existing.owner !== owner) {
      return { error: "Not authorized to delete this event" };
    }

    const res = await this.events.deleteOne({ _id: eventId as ID });
    if (res.deletedCount === 0) {
      return { error: "Event not found" };
    }

    return { ok: true };
  }

  /**
   * Query: _getEvents (owner: Owner, from: DateTime, to: DateTime) : (events: Set<Event>)
   */
  async _getEvents(
    { owner, from, to }: { owner: Owner; from: Date; to: Date },
  ): Promise<Array<{ events: EventState[] }>> {
    await this.ensureIndexes();
    // Two intervals [a.start, a.end] and [b.start, b.end] overlap if:
    // a.start < b.end AND a.end > b.start
    const overlaps = await this.events.find({
      owner,
      startTime: { $lt: to },
      endTime: { $gt: from },
    }).sort({ startTime: 1 }).toArray();

    return [{ events: overlaps }];
  }
}
