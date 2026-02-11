import { Collection, Db } from "npm:mongodb";
import { Empty, ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Declare collection prefix, use concept name
const PREFIX = "QuickCheckIns" + ".";

// Generic types of this concept (User and ExternalMetricID are IDs, not objects with properties known by this concept)
type User = ID;
type ExternalMetricID = ID; // The ID type for metrics managed externally/globally

// Internal entity types defined by the state of this concept
type CheckIn = ID; // CheckIn is an internal ID managed by this concept

/**
 * @state a set of CheckIns with
 *   an owner User
 *   an at DateTime
 *   a metric ExternalMetricID
 *   a value Number
 */
interface CheckInDocument {
  _id: CheckIn;
  owner: User;
  at: Date; // Using JavaScript's Date object for DateTime
  metric: ExternalMetricID;
  value: number;
}

/**
 * @state a set of InternalMetrics with
 *   a name String
 */
interface InternalMetricDocument {
  // Note: The _id of InternalMetrics will be of type ExternalMetricID
  _id: ExternalMetricID;
  owner: User;
  name: string;
}

/**
 * @concept QuickCheckIns [User, ExternalMetricID]
 * @purpose Record simple self-reports to correlate with recent meals.
 * @principle A user logs outcomes such as energy, mood, or gut comfort as numeric values at times; this concept stores facts only.
 */
export default class QuickCheckInsConcept {
  checkIns: Collection<CheckInDocument>;
  internalMetrics: Collection<InternalMetricDocument>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.checkIns = this.db.collection(PREFIX + "checkIns");
    this.internalMetrics = this.db.collection(PREFIX + "internalMetrics");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.checkIns.createIndex({ owner: 1, at: -1 }),
      this.checkIns.createIndex({ owner: 1, metric: 1 }),
      this.checkIns.createIndex({ metric: 1 }),
      this.internalMetrics.createIndex({ owner: 1, name: 1 }),
      this.internalMetrics.createIndex({ owner: 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * record (owner: User, at: Date, metric: ExternalMetricID, value: Number): ({checkIn: CheckIn} | {error: string})
   *
   * @requires the InternalMetric 'metric' exists
   * @effects create a new CheckIn 'checkIn', set its properties, and return its ID.
   */
  async record(
    { owner, at, metric, value }: {
      owner: User;
      at: Date;
      metric: ExternalMetricID;
      value: number;
    },
  ): Promise<{ checkIn: CheckIn } | { error: string }> {
    await this.ensureIndexes();
    // Requires: the InternalMetric 'metric' exists
    const existingMetric = await this.internalMetrics.findOne({
      _id: metric,
      owner,
    });
    if (!existingMetric) {
      return { error: `Metric with ID '${metric}' is not defined.` };
    }

    // Effects: create a new CheckIn 'checkIn', set its properties, and return its ID.
    const newCheckInId = freshID() as CheckIn;
    const result = await this.checkIns.insertOne({
      _id: newCheckInId,
      owner,
      at,
      metric,
      value,
    });

    if (!result.acknowledged) {
      return { error: "Failed to create check-in." };
    }

    return { checkIn: newCheckInId };
  }

  /**
   * defineMetric (owner: User, name: String): ({metric: ExternalMetricID} | {error: string})
   *
   * @requires no InternalMetric with 'name' exists for 'owner'
   * @effects create a new InternalMetric 'metric' with a fresh ID, set its name, and return its ID.
   */
  async defineMetric(
    { owner, name }: { owner: User; name: string },
  ): Promise<{ metric: ExternalMetricID } | { error: string }> {
    // Requires: no InternalMetric with 'name' exists for this owner
    const existingMetric = await this.internalMetrics.findOne({
      owner,
      name,
    });
    if (existingMetric) {
      return {
        error:
          `Metric with name '${name}' already exists with ID '${existingMetric._id}'.`,
      };
    }

    // Effects: create a new InternalMetric 'metric' with a fresh ID, set its name, and return its ID.
    const newMetricId = freshID() as ExternalMetricID;
    const result = await this.internalMetrics.insertOne({
      _id: newMetricId,
      owner,
      name: name,
    });

    if (!result.acknowledged) {
      return { error: "Failed to define metric." };
    }

    return { metric: newMetricId };
  }

  /**
   * edit (checkIn: CheckIn, owner: User, metric?: ExternalMetricID, value?: Number): (Empty | {error: string})
   *
   * @requires the CheckIn 'checkIn' exists, owner of 'checkIn' is 'owner', and if 'metric' is provided, then the InternalMetric 'metric' exists.
   * @effects update provided fields (metric and/or value) of 'checkIn'.
   */
  async edit(
    { checkIn, owner, metric, value }: {
      checkIn: CheckIn;
      owner: User;
      metric?: ExternalMetricID;
      value?: number;
    },
  ): Promise<Empty | { error: string }> {
    // Requires: the CheckIn 'checkIn' exists
    const existingCheckIn = await this.checkIns.findOne({ _id: checkIn });
    if (!existingCheckIn) {
      return { error: `Check-in with ID '${checkIn}' not found.` };
    }

    // Requires: owner of 'checkIn' is 'owner'
    if (existingCheckIn.owner !== owner) {
      return { error: "You are not the owner of this check-in." };
    }

    // Requires: if 'metric' is provided, then the InternalMetric 'metric' exists
    if (metric !== undefined) {
      const existingMetric = await this.internalMetrics.findOne({
        _id: metric,
        owner: existingCheckIn.owner,
      });
      if (!existingMetric) {
        return { error: `New metric with ID '${metric}' is not defined.` };
      }
    }

    // Effects: update provided fields (metric and/or value) of 'checkIn'.
    const updateDoc: Partial<Omit<CheckInDocument, "_id">> = {};
    if (metric !== undefined) {
      updateDoc.metric = metric;
    }
    if (value !== undefined) {
      updateDoc.value = value;
    }

    if (Object.keys(updateDoc).length === 0) {
      // No fields to update, can be considered a success.
      return {};
    }

    const result = await this.checkIns.updateOne(
      { _id: checkIn },
      { $set: updateDoc },
    );

    if (result.matchedCount === 0) {
      return { error: "Failed to update check-in." };
    }

    return {};
  }

  /**
   * delete (checkIn: CheckIn, owner: User): (Empty | {error: string})
   *
   * @requires the CheckIn 'checkIn' exists and its owner is 'owner'.
   * @effects permanently remove the check-in document.
   */
  async delete(
    { checkIn, owner }: { checkIn: CheckIn; owner: User },
  ): Promise<Empty | { error: string }> {
    const existingCheckIn = await this.checkIns.findOne({ _id: checkIn });
    if (!existingCheckIn) {
      // Per spec, this can be considered success (idempotency) or an error.
      // Returning error is more informative for the caller.
      return { error: `Check-in with ID '${checkIn}' not found.` };
    }
    if (existingCheckIn.owner !== owner) {
      return { error: "You are not the owner of this check-in." };
    }

    const result = await this.checkIns.deleteOne({ _id: checkIn, owner });

    if (result.deletedCount !== 1) {
      return { error: "Failed to delete check-in." };
    }
    return {};
  }

  /**
   * deleteByOwner (owner: User): (deleted: { checkIns: number; metrics: number })
   *
   * @effects Permanently removes all check-ins and metrics for the owner (account deletion cleanup).
   */
  async deleteByOwner(
    { owner }: { owner: User },
  ): Promise<{ checkIns: number; metrics: number }> {
    await this.ensureIndexes();
    const [checkInsRes, metricsRes] = await Promise.all([
      this.checkIns.deleteMany({ owner }),
      this.internalMetrics.deleteMany({ owner }),
    ]);
    return { checkIns: checkInsRes.deletedCount, metrics: metricsRes.deletedCount };
  }

  /**
   * deleteCheckInsByMetric (metric: ExternalMetricID): (deleted: number)
   *
   * @effects Permanently removes all check-ins referencing the metric (cascade when metric is removed).
   */
  async deleteCheckInsByMetric(
    { metric }: { metric: ExternalMetricID },
  ): Promise<{ deleted: number }> {
    await this.ensureIndexes();
    const res = await this.checkIns.deleteMany({ metric });
    return { deleted: res.deletedCount };
  }

  /**
   * deleteMetric (requester: User, metric: ExternalMetricID): ({deleted: true} | {error: string})
   *
   * @requires metric exists and is owned by requester and no CheckIn documents reference it.
   * @effects permanently remove the InternalMetric document.
   */
  async deleteMetric(
    { requester, metric }: { requester: User; metric: ExternalMetricID },
  ): Promise<{ deleted: true } | { error: string }> {
    // Requires: metric exists
    const existing = await this.internalMetrics.findOne({ _id: metric });
    if (!existing) {
      return { error: `Metric with ID '${metric}' not found.` };
    }
    if (existing.owner !== requester) {
      return { error: "You do not own this metric." };
    }
    // Requires: no CheckIn documents reference it
    const inUse = await this.checkIns.findOne({ metric });
    if (inUse) {
      return {
        error:
          "Cannot delete metric: there are existing check-ins referencing this metric.",
      };
    }

    // Effects: permanently remove the InternalMetric document
    const res = await this.internalMetrics.deleteOne({ _id: metric });
    if (res.deletedCount !== 1) {
      return { error: "Failed to delete metric." };
    }
    return { deleted: true };
  }

  // --- Queries ---

  /**
   * _getCheckIn (checkIn: CheckIn): (CheckInDocument | null)
   *
   * @effects Returns the check-in document if found, otherwise null.
   */
  async _getCheckIn(
    { checkIn }: { checkIn: CheckIn },
  ): Promise<CheckInDocument | null> {
    const doc = await this.checkIns.findOne({ _id: checkIn });
    return doc ?? null;
  }

  /**
   * _getMetricsByName (owner: User, name: String): (InternalMetricDocument | null)
   *
   * @effects Returns the metric document if found, otherwise null.
   */
  async _getMetricsByName(
    { owner, name }: { owner: User; name: string },
  ): Promise<InternalMetricDocument | null> {
    const doc = await this.internalMetrics.findOne({ owner, name });
    return doc ?? null;
  }

  /**
   * _listCheckInsByOwner (owner: User): (CheckInDocument[])
   *
   * @effects Returns all check-ins belonging to owner, sorted by at descending.
   */
  async _listCheckInsByOwner(
    { owner }: { owner: User },
  ): Promise<CheckInDocument[]> {
    await this.ensureIndexes();
    return await this.checkIns.find({ owner }).sort({ at: -1 }).toArray();
  }

  /**
   * _listMetricsForOwner (owner: User): (InternalMetricDocument[])
   *
   * @effects Returns all internal metrics for owner, sorted by name.
   */
  async _listMetricsForOwner(
    { owner }: { owner: User },
  ): Promise<InternalMetricDocument[]> {
    await this.ensureIndexes();
    return await this.internalMetrics.find({ owner }).sort({ name: 1 }).toArray();
  }
}
