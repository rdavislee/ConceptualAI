import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

/**
 * @concept Organizing
 * @purpose Define and organize the functional units of an organization or catalog and designate their leadership.
 */
export type UnitID = string;
export type ItemID = string;
export type Leader = ID;

const PREFIX = "Organizing" + ".";

interface Unit {
  _id: ID;
  name: string;
  description: string;
  leader: Leader | null;
}

interface Item {
  _id: ID;
  unit: string; // UnitID (ObjectId string)
  name: string;
  description: string;
  price?: number;
  active: boolean;
}

export default class OrganizingConcept {
  units: Collection<Unit>;
  items: Collection<Item>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.units = this.db.collection<Unit>(PREFIX + "units");
    this.items = this.db.collection<Item>(PREFIX + "items");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await Promise.all([
      this.units.createIndex({ leader: 1 }),
      this.items.createIndex({ unit: 1, active: 1 }),
    ]);
    this.indexesCreated = true;
  }

  /**
   * Action: createUnit (name: String, description: String, leader?: Leader) : (unit: UnitID)
   */
  async createUnit(
    { name, description, leader }: { name: string; description: string; leader?: Leader },
  ): Promise<{ unitId: string } | { error: string }> {
    if (!name || name.trim().length === 0) {
      return { error: "Unit name cannot be empty" };
    }

    const unitId = freshID();
    await this.units.insertOne({
      _id: unitId,
      name,
      description,
      leader: leader ?? null,
    });

    return { unitId };
  }

  /**
   * Action: updateUnit (unit: UnitID, name?: String, description?: String, leader?: Leader) : (ok: Flag)
   */
  async updateUnit(
    { unit, name, description, leader }: {
      unit: string;
      name?: string;
      description?: string;
      leader?: Leader;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    const update: any = {};
    if (name !== undefined) {
      if (name.trim().length === 0) return { error: "Name cannot be empty" };
      update.name = name;
    }
    if (description !== undefined) update.description = description;
    if (leader !== undefined) update.leader = leader;

    if (Object.keys(update).length === 0) {
      return { error: "At least one field must be provided for update" };
    }

    const res = await this.units.updateOne({ _id: unit as ID }, { $set: update });
    if (res.matchedCount === 0) {
      return { error: "Unit not found" };
    }

    return { ok: true };
  }

  /**
   * Action: createItem (unit: UnitID, name: String, description: String, price?: Number) : (item: ItemID)
   */
  async createItem(
    { unit, name, description, price }: {
      unit: string;
      name: string;
      description: string;
      price?: number;
    },
  ): Promise<{ itemId: string } | { error: string }> {
    if (price !== undefined && price < 0) {
      return { error: "Price must be non-negative" };
    }

    const unitExists = await this.units.findOne({ _id: unit as ID });
    if (!unitExists) {
      return { error: "Unit does not exist" };
    }

    const itemId = freshID();
    await this.items.insertOne({
      _id: itemId,
      unit,
      name,
      description,
      price,
      active: true,
    });

    return { itemId };
  }

  /**
   * Action: updateItem (item: ItemID, name?: String, price?: Number, active?: Flag) : (ok: Flag)
   */
  async updateItem(
    { item, name, price, active }: {
      item: string;
      name?: string;
      price?: number;
      active?: boolean;
    },
  ): Promise<{ ok: boolean } | { error: string }> {
    const update: any = {};
    if (name !== undefined) update.name = name;
    if (price !== undefined) {
      if (price < 0) return { error: "Price must be non-negative" };
      update.price = price;
    }
    if (active !== undefined) update.active = active;

    if (Object.keys(update).length === 0) {
      return { error: "At least one field must be provided for update" };
    }

    const res = await this.items.updateOne({ _id: item as ID }, { $set: update });
    if (res.matchedCount === 0) {
      return { error: "Item not found" };
    }

    return { ok: true };
  }

  /**
   * Delete lifecycle: remove all units led by a leader (for account deletion).
   * Sets leader to null on affected units rather than deleting units.
   */
  async deleteByLeader({ leader }: { leader: Leader }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    await this.units.updateMany({ leader }, { $set: { leader: null } });
    return { ok: true };
  }

  /**
   * Delete lifecycle: remove a unit and cascade-delete all items in that unit.
   */
  async deleteUnit({ unit }: { unit: string }): Promise<{ ok: boolean } | { error: string }> {
    await this.ensureIndexes();
    const exists = await this.units.findOne({ _id: unit as ID });
    if (!exists) {
      return { error: "Unit not found" };
    }

    await Promise.all([
      this.items.deleteMany({ unit }),
      this.units.deleteOne({ _id: unit as ID }),
    ]);
    return { ok: true };
  }

  /**
   * Action: deleteItem (item: ItemID) : (ok: Flag)
   */
  async deleteItem(
    { item }: { item: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.items.deleteOne({ _id: item as ID });
    if (res.deletedCount === 0) {
      return { error: "Item not found" };
    }

    return { ok: true };
  }

  /**
   * Query: _getAllUnits () : (units: Set<Unit>)
   */
  async _getAllUnits(): Promise<Array<{ units: Unit[] }>> {
    await this.ensureIndexes();
    const units = await this.units.find().toArray();
    return [{ units }];
  }

  /**
   * Query: _getUnit (unit: UnitID) : (unit: Unit?)
   */
  async _getUnit(
    { unit }: { unit: string },
  ): Promise<Array<{ unit: Unit | null }>> {
    const doc = await this.units.findOne({ _id: unit as ID });
    return [{ unit: doc }];
  }

  /**
   * Query: _getItemsByUnit (unit: UnitID) : (items: Set<Item>)
   */
  async _getItemsByUnit(
    { unit }: { unit: string },
  ): Promise<Array<{ items: Item[] }>> {
    await this.ensureIndexes();
    const items = await this.items.find({ unit, active: true }).toArray();
    return [{ items }];
  }
}
