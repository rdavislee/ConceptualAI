import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
// Scheduling [Resource, Client]
export type Resource = ID;
export type Client = ID;

const PREFIX = "Scheduling" + ".";

const STATUSES = ["booked", "cancelled"] as const;
type Status = typeof STATUSES[number];

interface AvailabilityBlock {
  _id: ID;
  resource: Resource;
  start: Date;
  end: Date;
}

interface Appointment {
  _id: ID;
  resource: Resource;
  client: Client;
  start: Date;
  end: Date;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept Scheduling
 * @purpose Manage the availability of resources and allow clients to reserve exclusive time slots within that availability.
 */
export default class SchedulingConcept {
  availability: Collection<AvailabilityBlock>;
  appointments: Collection<Appointment>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.availability = this.db.collection<AvailabilityBlock>(PREFIX + "availability");
    this.appointments = this.db.collection<Appointment>(PREFIX + "appointments");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.availability.createIndex({ resource: 1, start: 1, end: 1 }),
      this.appointments.createIndex({ resource: 1, status: 1, start: 1, end: 1 }),
      this.appointments.createIndex({ client: 1, start: 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: addAvailability (resource: Resource, start: DateTime, end: DateTime) : (blockId: ID)
   */
  async addAvailability(
    { resource, start, end }: { resource: Resource; start: Date; end: Date },
  ): Promise<{ blockId: string } | { error: string }> {
    await this.ensureIndexes();
    if (start >= end) {
      return { error: "Start must be before end" };
    }

    const blockId = freshID();
    await this.availability.insertOne({
      _id: blockId,
      resource,
      start,
      end,
    });

    return { blockId };
  }

  /**
   * deleteByResource (resource: Resource): (blocks: number, appointments: number)
   * @effects Removes all availability blocks and appointments for the resource.
   */
  async deleteByResource(
    { resource }: { resource: Resource },
  ): Promise<{ blocks: number; appointments: number }> {
    await this.ensureIndexes();
    const [blocksRes, appointmentsRes] = await Promise.all([
      this.availability.deleteMany({ resource }),
      this.appointments.deleteMany({ resource }),
    ]);
    return { blocks: blocksRes.deletedCount, appointments: appointmentsRes.deletedCount };
  }

  /**
   * deleteByClient (client: Client): (deleted: number)
   * @effects Removes all appointments for the client (account deletion cleanup).
   */
  async deleteByClient(
    { client }: { client: Client },
  ): Promise<{ deleted: number }> {
    await this.ensureIndexes();
    const res = await this.appointments.deleteMany({ client });
    return { deleted: res.deletedCount };
  }

  /**
   * Action: removeAvailability (blockId: ID) : (ok: Flag)
   */
  async removeAvailability(
    { blockId }: { blockId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.availability.deleteOne({ _id: blockId as ID });
    if (res.deletedCount === 0) {
      return { error: "Availability block not found" };
    }

    return { ok: true };
  }

  /**
   * Action: updateAvailability (blockId: ID, start: DateTime, end: DateTime) : (ok: Flag)
   */
  async updateAvailability(
    { blockId, start, end }: { blockId: string; start: Date; end: Date },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (start >= end) {
      return { error: "Start must be before end" };
    }

    const res = await this.availability.updateOne(
      { _id: blockId as ID },
      { $set: { start, end } },
    );

    if (res.matchedCount === 0) {
      return { error: "Availability block not found" };
    }

    return { ok: true };
  }

  /**
   * Action: book (resource: Resource, client: Client, start: DateTime, end: DateTime) : (appointmentId: ID)
   */
  async book(
    { resource, client, start, end }: { resource: Resource; client: Client; start: Date; end: Date },
  ): Promise<{ appointmentId: string } | { error: string }> {
    await this.ensureIndexes();
    if (start >= end) {
      return { error: "Start must be before end" };
    }

    // Check availability: find a block that contains [start, end]
    const availableBlock = await this.availability.findOne({
      resource,
      start: { $lte: start },
      end: { $gte: end },
    });

    if (!availableBlock) {
      return { error: "No availability for this time slot" };
    }

    // Check for conflicts: overlapping booked appointments
    // Two intervals [a.start, a.end] and [b.start, b.end] overlap if:
    // a.start < b.end AND a.end > b.start
    const conflict = await this.appointments.findOne({
      resource,
      status: "booked",
      start: { $lt: end },
      end: { $gt: start },
    });

    if (conflict) {
      return { error: "Time slot conflicts with existing appointment" };
    }

    const now = new Date();
    const appointmentId = freshID();
    await this.appointments.insertOne({
      _id: appointmentId,
      resource,
      client,
      start,
      end,
      status: "booked",
      createdAt: now,
      updatedAt: now,
    });

    return { appointmentId };
  }

  /**
   * Action: cancel (appointmentId: ID) : (ok: Flag)
   */
  async cancel(
    { appointmentId }: { appointmentId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.appointments.updateOne(
      { _id: appointmentId as ID, status: "booked" },
      { $set: { status: "cancelled", updatedAt: new Date() } },
    );

    if (res.matchedCount === 0) {
      return { error: "Appointment not found or already cancelled" };
    }

    return { ok: true };
  }

  /**
   * Action: reschedule (appointmentId: ID, newStart: DateTime, newEnd: DateTime) : (ok: Flag)
   */
  async reschedule(
    { appointmentId, newStart, newEnd }: { appointmentId: string; newStart: Date; newEnd: Date },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (newStart >= newEnd) {
      return { error: "Start must be before end" };
    }

    // Get the appointment
    const appointment = await this.appointments.findOne({ _id: appointmentId as ID, status: "booked" });
    if (!appointment) {
      return { error: "Appointment not found or not booked" };
    }

    // Check availability for new time
    const availableBlock = await this.availability.findOne({
      resource: appointment.resource,
      start: { $lte: newStart },
      end: { $gte: newEnd },
    });

    if (!availableBlock) {
      return { error: "No availability for new time slot" };
    }

    // Check for conflicts (excluding this appointment)
    const conflict = await this.appointments.findOne({
      _id: { $ne: appointmentId as ID },
      resource: appointment.resource,
      status: "booked",
      start: { $lt: newEnd },
      end: { $gt: newStart },
    });

    if (conflict) {
      return { error: "New time slot conflicts with existing appointment" };
    }

    // Update appointment
    await this.appointments.updateOne(
      { _id: appointmentId as ID },
      { $set: { start: newStart, end: newEnd, updatedAt: new Date() } },
    );

    return { ok: true };
  }

  /**
   * Query: _getAvailability (resource: Resource, start: DateTime, end: DateTime) : (blocks: Set<AvailabilityBlock>)
   */
  async _getAvailability(
    { resource, start, end }: { resource: Resource; start: Date; end: Date },
  ): Promise<Array<{ blocks: AvailabilityBlock[] }>> {
    const blocks = await this.availability.find({
      resource,
      start: { $lt: end },
      end: { $gt: start },
    }).toArray();

    return [{ blocks }];
  }

  /**
   * Query: _getAppointments (resource: Resource, start: DateTime, end: DateTime) : (appointments: Set<Appointment>)
   */
  async _getAppointments(
    { resource, start, end }: { resource: Resource; start: Date; end: Date },
  ): Promise<Array<{ appointments: Appointment[] }>> {
    const appointments = await this.appointments.find({
      resource,
      start: { $lt: end },
      end: { $gt: start },
    }).toArray();

    return [{ appointments }];
  }

  /**
   * Query: _getClientAppointments (client: Client) : (appointments: Set<Appointment>)
   */
  async _getClientAppointments(
    { client }: { client: Client },
  ): Promise<Array<{ appointments: Appointment[] }>> {
    const appointments = await this.appointments.find({ client }).sort({ start: 1 }).toArray();
    return [{ appointments }];
  }

  /**
   * Query: _getAppointment (appointmentId: ID) : (appointment: Appointment?)
   */
  async _getAppointment(
    { appointmentId }: { appointmentId: string },
  ): Promise<Array<{ appointment: Appointment | null }>> {
    const appointment = await this.appointments.findOne({ _id: appointmentId as ID });
    return [{ appointment }];
  }
}
