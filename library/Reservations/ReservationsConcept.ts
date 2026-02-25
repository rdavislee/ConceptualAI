import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
// Reservations [BookingID, CustomerID]
export type BookingID = string;
export type CustomerID = ID;

const PREFIX = "Reservations" + ".";

const STATUSES = ["confirmed", "cancelled"] as const;
type Status = typeof STATUSES[number];

interface Capacity {
  _id: string; // timeSlot ISO string
  timeSlot: Date;
  maxCapacity: number;
}

interface Booking {
  _id: ID;
  customer: CustomerID;
  timeSlot: Date;
  partySize: number;
  details: Record<string, any>;
  status: Status;
  createdAt: Date;
}

/**
 * @concept Reservations
 * @purpose Manage the limited seating capacity to prevent overbooking.
 */
export default class ReservationsConcept {
  capacities: Collection<Capacity>;
  bookings: Collection<Booking>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.capacities = this.db.collection<Capacity>(PREFIX + "capacities");
    this.bookings = this.db.collection<Booking>(PREFIX + "bookings");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.bookings.createIndex({ timeSlot: 1, status: 1 }),
      this.bookings.createIndex({ customer: 1, timeSlot: 1 }),
      this.bookings.createIndex({ customer: 1 }),
    ]);
    this.indexesCreated = true;
  }

  private getSlotKey(timeSlot: Date): string {
    return timeSlot.toISOString();
  }

  /**
   * Action: setCapacity (timeSlot: DateTime, maxCapacity: Number) : (ok: Flag)
   */
  async setCapacity(
    { timeSlot, maxCapacity }: { timeSlot: Date; maxCapacity: number },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (maxCapacity <= 0) {
      return { error: "Max capacity must be greater than 0" };
    }

    const slotKey = this.getSlotKey(timeSlot);
    await this.capacities.updateOne(
      { _id: slotKey },
      { $set: { timeSlot, maxCapacity } },
      { upsert: true },
    );

    return { ok: true };
  }

  /**
   * Action: book (customer: CustomerID, timeSlot: DateTime, partySize: Number, details: Object) : (bookingId: BookingID)
   */
  async book(
    { customer, timeSlot, partySize, details }: {
      customer: CustomerID;
      timeSlot: Date;
      partySize: number;
      details: Record<string, any>;
    },
  ): Promise<{ bookingId: string } | { error: string }> {
    await this.ensureIndexes();
    if (partySize <= 0) {
      return { error: "Party size must be greater than 0" };
    }

    const slotKey = this.getSlotKey(timeSlot);

    // Get capacity for this slot
    const capacityDoc = await this.capacities.findOne({ _id: slotKey });
    const maxCapacity = capacityDoc?.maxCapacity ?? 0;

    if (maxCapacity === 0) {
      return { error: "No capacity set for this time slot" };
    }

    // Calculate current load
    const confirmedBookings = await this.bookings.find({
      timeSlot,
      status: "confirmed",
    }).toArray();

    const currentLoad = confirmedBookings.reduce((sum: number, b: Booking) => sum + b.partySize, 0);

    // Check if new booking would exceed capacity
    if (currentLoad + partySize > maxCapacity) {
      return { error: `Insufficient capacity. Available: ${maxCapacity - currentLoad}, Requested: ${partySize}` };
    }

    // Create booking
    const bookingId = freshID();
    await this.bookings.insertOne({
      _id: bookingId,
      customer,
      timeSlot,
      partySize,
      details,
      status: "confirmed",
      createdAt: new Date(),
    });

    return { bookingId };
  }

  /**
   * deleteByCustomer (customer: CustomerID): (deleted: number)
   * @effects Removes all bookings for the customer (account deletion cleanup).
   */
  async deleteByCustomer(
    { customer }: { customer: CustomerID },
  ): Promise<{ deleted: number }> {
    await this.ensureIndexes();
    const res = await this.bookings.deleteMany({ customer });
    return { deleted: res.deletedCount };
  }

  /**
   * deleteByTimeSlot (timeSlot: Date): (deleted: number)
   * @effects Removes all bookings for the time slot (capacity slot removal cleanup).
   */
  async deleteByTimeSlot(
    { timeSlot }: { timeSlot: Date },
  ): Promise<{ deleted: number }> {
    await this.ensureIndexes();
    const res = await this.bookings.deleteMany({ timeSlot });
    return { deleted: res.deletedCount };
  }

  /**
   * Action: cancel (bookingId: BookingID) : (ok: Flag)
   */
  async cancel(
    { bookingId }: { bookingId: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.bookings.updateOne(
      { _id: bookingId as ID },
      { $set: { status: "cancelled" } },
    );

    if (res.matchedCount === 0) {
      return { error: "Booking not found" };
    }

    return { ok: true };
  }

  /**
   * Query: _getAvailability (date: DateTime, partySize: Number) : (slots: Set<DateTime>)
   */
  async _getAvailability(
    { date, partySize }: { date: Date; partySize: number },
  ): Promise<Array<{ slots: Date[] }>> {
    await this.ensureIndexes();
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const capacities = await this.capacities.find({
      timeSlot: { $gte: startOfDay, $lte: endOfDay },
    }).toArray();

    const availableSlots: Date[] = [];
    for (const cap of capacities) {
      const confirmedBookings = await this.bookings.find({
        timeSlot: cap.timeSlot,
        status: "confirmed",
      }).toArray();
      const currentLoad = confirmedBookings.reduce((sum: number, b: Booking) => sum + b.partySize, 0);
      if (currentLoad + partySize <= cap.maxCapacity) {
        availableSlots.push(cap.timeSlot);
      }
    }

    return [{ slots: availableSlots }];
  }

  /**
   * Query: _getBookings (date: DateTime) : (bookings: Set<Booking>)
   */
  async _getBookings(
    { date }: { date: Date },
  ): Promise<Array<{ bookings: Booking[] }>> {
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const bookings = await this.bookings.find({
      timeSlot: { $gte: startOfDay, $lte: endOfDay },
    }).toArray();

    return [{ bookings }];
  }

  /**
   * Query: _getBooking (bookingId: BookingID) : (booking: Booking?)
   */
  async _getBooking(
    { bookingId }: { bookingId: string },
  ): Promise<Array<{ booking: Booking | null }>> {
    const booking = await this.bookings.findOne({ _id: bookingId as ID });
    return [{ booking }];
  }

  /**
   * Query: _getCustomerBookings (customer: CustomerID) : (bookings: Set<Booking>)
   */
  async _getCustomerBookings(
    { customer }: { customer: CustomerID },
  ): Promise<Array<{ bookings: Booking[] }>> {
    const bookings = await this.bookings.find({ customer }).sort({ timeSlot: 1 }).toArray();
    return [{ bookings }];
  }
}
