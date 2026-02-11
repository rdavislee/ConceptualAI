**concept** Organizing [UnitID, ItemID, Leader]

**purpose**
Define and organize the functional units of an organization or catalog and designate their leadership.

**principle**
An organization creates functional units (Units) to group related activities or offerings. Each unit can be assigned a Leader who is responsible for that unit. Items (resources, offerings, or assets) are associated with a single unit. When browsing, items are presented grouped by their respective units.

**state**
  a set of Units with
    a id UnitID
    a name String
    a description String
    a leader Leader | null

  a set of Items with
    a id ItemID
    a unit UnitID
    a name String
    a description String
    a price Number?
    a active Flag

**actions**

createUnit (name: String, description: String, leader?: Leader) : (unit: UnitID)
  **requires**
    name is not empty
  **effects**
    creates a new functional Unit

updateUnit (unit: UnitID, name?: String, description?: String, leader?: Leader) : (ok: Flag)
  **requires**
    unit exists. If name provided, it must not be empty.
  **effects**
    updates the name, description, and/or leader of the unit

createItem (unit: UnitID, name: String, description: String, price?: Number) : (item: ItemID)
  **requires**
    unit exists. If price provided, it must be >= 0.
  **effects**
    creates a new Item associated with the unit, sets active := true

updateItem (item: ItemID, name?: String, price?: Number, active?: Flag) : (ok: Flag)
  **requires**
    item exists. If price provided, it must be >= 0.
  **effects**
    updates the specified fields of the item

deleteItem (item: ItemID) : (ok: Flag)
  **requires**
    item exists
  **effects**
    removes the item record

deleteByLeader (leader: Leader) : (ok: Flag)
  **requires** true
  **effects** sets leader to null on all units led by leader (for account deletion)

deleteUnit (unit: UnitID) : (ok: Flag)
  **requires** unit exists
  **effects** removes the unit and cascade-deletes all items in that unit

**queries**

_getAllUnits () : (units: Set<Unit>)
  **requires** true
  **effects** returns all units

_getUnit (unit: UnitID) : (unit: Unit?)
  **requires** true
  **effects** returns the unit details

_getItemsByUnit (unit: UnitID) : (items: Set<Item>)
  **requires** true
  **effects** returns all active items belonging to the unit
