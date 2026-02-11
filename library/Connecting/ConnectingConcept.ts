import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

// Generic external parameter types
// Connecting [Requester, Responder]
export type Requester = ID;
export type Responder = ID;

const PREFIX = "Connecting" + ".";

const STATUSES = ["pending", "connected"] as const;
type Status = typeof STATUSES[number];

interface ConnectionState {
  _id: string; // requester:responder
  requester: Requester;
  responder: Responder;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept Connecting
 * @purpose Manage the lifecycle of bidirectional relationships that require manual approval (e.g., friending, connection requests).
 */
export default class ConnectingConcept {
  connections: Collection<ConnectionState>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.connections = this.db.collection<ConnectionState>(PREFIX + "connections");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.connections.createIndex({ responder: 1, status: 1 });
    await this.connections.createIndex({ requester: 1, status: 1 });
    this.indexesCreated = true;
  }

  private getId(partyA: string, partyB: string): string {
    // Sort IDs to ensure uniqueness for bidirectional relationship
    return [partyA, partyB].sort().join(":");
  }

  /**
   * Action: requestConnection (requester: Requester, responder: Responder) : (ok: Flag)
   */
  async requestConnection(
    { requester, responder }: { requester: Requester; responder: Responder },
  ): Promise<{ ok: boolean } | { error: string }> {
    if (requester === responder) {
      return { error: "Cannot connect with self" };
    }

    await this.ensureIndexes();
    const _id = this.getId(requester, responder);
    const existing = await this.connections.findOne({ _id });
    if (existing) {
      return { error: "Connection or request already exists" };
    }

    const now = new Date();
    await this.connections.insertOne({
      _id,
      requester, // requester is strictly the one who initiated
      responder,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    return { ok: true };
  }

  /**
   * Action: acceptConnection (responder: Responder, requester: Requester) : (ok: Flag)
   */
  async acceptConnection(
    { responder, requester }: { responder: Responder; requester: Requester },
  ): Promise<{ ok: boolean } | { error: string }> {
    const _id = this.getId(requester, responder);
    // Explicitly check that the 'responder' is the one accepting
    const pending = await this.connections.findOne({ _id, requester, responder, status: "pending" });
    if (!pending) {
      return { error: "No pending request found from this requester" };
    }

    await this.connections.updateOne(
      { _id },
      { $set: { status: "connected", updatedAt: new Date() } },
    );

    return { ok: true };
  }

  /**
   * Action: rejectConnection (responder: Responder, requester: Requester) : (ok: Flag)
   */
  async rejectConnection(
    { responder, requester }: { responder: Responder; requester: Requester },
  ): Promise<{ ok: boolean } | { error: string }> {
    const _id = this.getId(requester, responder);
    const res = await this.connections.deleteOne({ _id, requester, responder, status: "pending" });
    if (res.deletedCount === 0) {
      return { error: "No pending request found from this requester" };
    }
    return { ok: true };
  }

  /**
   * Action: removeConnection (partyA: Requester, partyB: Responder) : (ok: Flag)
   */
  async removeConnection(
    { partyA, partyB }: { partyA: Requester; partyB: Responder },
  ): Promise<{ ok: boolean } | { error: string }> {
    const _id = this.getId(partyA, partyB);
    const res = await this.connections.deleteOne({ _id });
    if (res.deletedCount === 0) {
      return { error: "No connection found" };
    }
    return { ok: true };
  }

  /**
   * Lifecycle: deleteByRequester (requester: Requester) : (ok: Flag)
   * Deletes all connections where the given user is the requester. Use when requester account is deleted.
   */
  async deleteByRequester({ requester }: { requester: Requester }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.connections.deleteMany({ requester });
    return { ok: true };
  }

  /**
   * Lifecycle: deleteByResponder (responder: Responder) : (ok: Flag)
   * Deletes all connections where the given user is the responder. Use when responder account is deleted.
   */
  async deleteByResponder({ responder }: { responder: Responder }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.connections.deleteMany({ responder });
    return { ok: true };
  }

  /**
   * Query: _isConnected (partyA: Requester, partyB: Responder) : (connected: Flag)
   */
  async _isConnected(
    { partyA, partyB }: { partyA: Requester; partyB: Responder },
  ): Promise<Array<{ connected: boolean }>> {
    const _id = this.getId(partyA, partyB);
    const connection = await this.connections.findOne({ _id, status: "connected" });
    return [{ connected: !!connection }];
  }

  /**
   * Query: _getPendingRequests (responder: Responder) : (requesters: Set<Requester>)
   */
  async _getPendingRequests(
    { responder }: { responder: Responder },
  ): Promise<Array<{ requesters: Requester[] }>> {
    const requests = await this.connections.find({ responder, status: "pending" }).toArray();
    return [{ requesters: requests.map((r: ConnectionState) => r.requester) }];
  }

  /**
   * Query: _getConnections (user: Requester) : (users: Set<Responder>)
   */
  async _getConnections(
    { user }: { user: string },
  ): Promise<Array<{ users: string[] }>> {
    const connections = await this.connections.find({
      $or: [{ requester: user as Requester }, { responder: user as Responder }],
      status: "connected",
    }).toArray();

    const users = connections.map((c: ConnectionState) => c.requester === user ? c.responder : c.requester);
    return [{ users: users as string[] }];
  }
}
