import { Collection, Db, ObjectId } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Reporting [Reporter, Target, Report]
export type Reporter = ID;
export type Target = ID;
export type Report = string;

const PREFIX = "Reporting" + ".";

const STATUSES = ["pending", "resolved", "dismissed"] as const;
type Status = typeof STATUSES[number];

interface ReportState {
  _id: ObjectId;
  reporter: Reporter;
  target: Target;
  reason: string;
  details?: Record<string, any>;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
  resolvedBy?: ID;
}

/**
 * @concept Reporting
 * @purpose Enables users to flag content or other users for moderation review.
 */
export default class ReportingConcept {
  reports: Collection<ReportState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.reports = this.db.collection<ReportState>(PREFIX + "reports");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.reports.createIndex({ status: 1, createdAt: 1 }),
      this.reports.createIndex({ reporter: 1 }),
      this.reports.createIndex({ target: 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: report (reporter: Reporter, target: Target, reason: String, details?: Object) : (reportId: Report)
   */
  async report(
    { reporter, target, reason, details }: {
      reporter: Reporter;
      target: Target;
      reason: string;
      details?: Record<string, any>;
    },
  ): Promise<{ reportId: string } | { error: string }> {
    await this.ensureIndexes();
    if (!reason) {
      return { error: "Reason cannot be empty" };
    }

    const now = new Date();
    const res = await this.reports.insertOne({
      _id: new ObjectId(),
      reporter,
      target,
      reason,
      details,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    return { reportId: res.insertedId.toHexString() };
  }

  /**
   * Action: resolveReport (reportId: Report, status: String, resolver?: ID) : (ok: Flag)
   */
  async resolveReport(
    { reportId, status, resolver }: { reportId: string; status: string; resolver?: ID },
  ): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    if (!STATUSES.includes(status as Status) || status === "pending") {
      return { error: `Invalid status: ${status}. Must be one of resolved, dismissed` };
    }

    let oid: ObjectId;
    try {
      oid = new ObjectId(reportId);
    } catch {
      return { error: "Invalid report ID" };
    }

    const update: Record<string, unknown> = { status: status as Status, updatedAt: new Date() };
    if (resolver !== undefined) {
      update.resolvedBy = resolver;
    }

    const res = await this.reports.updateOne(
      { _id: oid },
      { $set: update },
    );

    if (res.matchedCount === 0) {
      return { error: "Report not found" };
    }

    return { ok: true };
  }

  /**
   * deleteByReporter (reporter: Reporter): (deleted: number)
   * @effects Removes all reports by the reporter (account deletion cleanup).
   */
  async deleteByReporter(
    { reporter }: { reporter: Reporter },
  ): Promise<{ deleted: number }> {
    await this.ensureIndexes();
    const res = await this.reports.deleteMany({ reporter });
    return { deleted: res.deletedCount };
  }

  /**
   * deleteByTarget (target: Target): (deleted: number)
   * @effects Removes all reports against the target (target deletion cleanup).
   */
  async deleteByTarget(
    { target }: { target: Target },
  ): Promise<{ deleted: number }> {
    await this.ensureIndexes();
    const res = await this.reports.deleteMany({ target });
    return { deleted: res.deletedCount };
  }

  /**
   * Query: _getPendingReports () : (reports: Set<Report>)
   */
  async _getPendingReports(): Promise<Array<{ reports: ReportState[] }>> {
    await this.ensureIndexes();
    const reports = await this.reports.find({ status: "pending" }).sort({ createdAt: 1 }).toArray();
    return [{ reports }];
  }

  /**
   * Query: _getReport (reportId: Report) : (report: Report | null)
   */
  async _getReport(
    { reportId }: { reportId: string },
  ): Promise<Array<{ report: ReportState | null }>> {
    let oid: ObjectId;
    try {
      oid = new ObjectId(reportId);
    } catch {
      return [{ report: null }];
    }

    const report = await this.reports.findOne({ _id: oid });
    return [{ report }];
  }
}
