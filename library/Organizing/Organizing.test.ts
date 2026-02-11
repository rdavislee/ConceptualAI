import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import OrganizingConcept, { UnitID, ItemID, Leader } from "./OrganizingConcept.ts";

const alice = "user:alice" as Leader;
const bob = "user:bob" as Leader;

Deno.test("Organizing: Unit lifecycle and cross-unit queries", async () => {
  const [db, client] = await testDb();
  const org = new OrganizingConcept(db);
  try {
    // 1. Create multiple units
    const engineering = await org.createUnit({ name: "Engineering", description: "Bugs vs Features", leader: alice });
    const product = await org.createUnit({ name: "Product", description: "Visions and Roadmaps" });
    if ("error" in engineering || "error" in product) throw new Error();

    // 2. Test _getAllUnits
    const allUnits = await org._getAllUnits();
    assertEquals(allUnits[0].units.length, 2);

    // 3. Update Unit fields
    await org.updateUnit({
      unit: engineering.unitId,
      name: "Platform Engineering",
      description: "Everything is infrastructure"
    });
    const updated = await org._getUnit({ unit: engineering.unitId });
    assertEquals(updated[0].unit?.name, "Platform Engineering");

    // 4. Test empty name validation
    const err = await org.createUnit({ name: "", description: "" });
    assertEquals("error" in err, true);

  } finally {
    await client.close();
  }
});

Deno.test("Organizing: Item state and visibility logic", async () => {
  const [db, client] = await testDb();
  const org = new OrganizingConcept(db);
  try {
    const unitRes = await org.createUnit({ name: "Lab", description: "" });
    if ("error" in unitRes) throw new Error();

    // 1. Create items
    const i1 = await org.createItem({ unit: unitRes.unitId, name: "Active Item", description: "" });
    const i2 = await org.createItem({ unit: unitRes.unitId, name: "Inactive Item", description: "" });
    if ("error" in i1 || "error" in i2) throw new Error();

    // 2. Set one item to inactive
    await org.updateItem({ item: i2.itemId, active: false });

    // 3. Verify _getItemsByUnit only returns ACTIVE items
    const visible = await org._getItemsByUnit({ unit: unitRes.unitId });
    assertEquals(visible[0].items.length, 1);
    assertEquals(visible[0].items[0].name, "Active Item");

    // 4. Update item metadata
    await org.updateItem({ item: i1.itemId, name: "Super Active Item", price: 99.99 });
    const check = await org._getItemsByUnit({ unit: unitRes.unitId });
    assertEquals(check[0].items[0].name, "Super Active Item");
    assertEquals(check[0].items[0].price, 99.99);

  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Lifecycle: deleteByLeader clears leader from units",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const org = new OrganizingConcept(db);
    try {
      const u1 = await org.createUnit({ name: "U1", description: "", leader: alice });
      const u2 = await org.createUnit({ name: "U2", description: "", leader: bob });
      if ("error" in u1 || "error" in u2) throw new Error();

      await org.deleteByLeader({ leader: alice });

      const unit1 = await org._getUnit({ unit: u1.unitId });
      assertEquals(unit1[0].unit?.leader, null);

      const unit2 = await org._getUnit({ unit: u2.unitId });
      assertEquals(unit2[0].unit?.leader, bob);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Lifecycle: deleteUnit cascades to items",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const org = new OrganizingConcept(db);
    try {
      const u = await org.createUnit({ name: "ToDelete", description: "" });
      if ("error" in u) throw new Error();

      const i1 = await org.createItem({ unit: u.unitId, name: "I1", description: "" });
      const i2 = await org.createItem({ unit: u.unitId, name: "I2", description: "" });
      if ("error" in i1 || "error" in i2) throw new Error();

      const res = await org.deleteUnit({ unit: u.unitId });
      assertEquals("ok" in res, true);

      const units = await org._getAllUnits();
      assertEquals(units[0].units.some((x: { name: string }) => x.name === "ToDelete"), false);

      const items = await org._getItemsByUnit({ unit: u.unitId });
      assertEquals(items[0].items.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Organizing: Validation and error handling",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const org = new OrganizingConcept(db);
    try {
      const unitRes = await org.createUnit({ name: "Vault", description: "" });
      if ("error" in unitRes) throw new Error();

      // 1. Create item in non-existent unit
      const badUnit = await org.createItem({
        unit: "507f1f77bcf86cd799439011",
        name: "Ghost",
        description: "",
      });
      assertEquals("error" in badUnit, true);

      // 2. Invalid price
      const badPrice = await org.createItem({
        unit: unitRes.unitId,
        name: "Negative",
        description: "",
        price: -5,
      });
      assertEquals("error" in badPrice, true);

      // 3. Update non-existent item
      const noItem = await org.updateItem({
        item: "507f1f77bcf86cd799439011",
        name: "New Name",
      });
      assertEquals("error" in noItem, true);

      // 4. Update non-existent unit
      const noUnit = await org.updateUnit({
        unit: "507f1f77bcf86cd799439011",
        name: "New Name",
      });
      assertEquals("error" in noUnit, true);

      // 5. Invalid ID format
      const badId = await org.deleteItem({ item: "not-an-object-id" });
      assertEquals("error" in badId, true);
    } finally {
      await client.close();
    }
  },
});
