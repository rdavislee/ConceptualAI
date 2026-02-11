import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import SettingConcept, { Namespace } from "./SettingConcept.ts";

const bizInfo = "establishment-info" as Namespace;
const appConfig = "app-config" as Namespace;

Deno.test("Setting: Set and get settings", async () => {
  const [db, client] = await testDb();
  const setting = new SettingConcept(db);
  try {
    const data = {
      address: "123 Main St",
      phone: "555-0199",
      description: "A cozy cafe",
      hours: "9am-5pm",
    };

    // Set setting
    const res = await setting.setSetting({ namespace: bizInfo, data });
    assertEquals(res, { ok: true });

    // Get setting
    const got = await setting._getSetting({ namespace: bizInfo });
    assertEquals(got[0].data, data);

  } finally {
    await client.close();
  }
});

Deno.test("Setting: Overwrite existing setting", async () => {
  const [db, client] = await testDb();
  const setting = new SettingConcept(db);
  try {
    await setting.setSetting({ namespace: appConfig, data: { theme: "light" } });

    // Update setting
    await setting.setSetting({ namespace: appConfig, data: { theme: "dark" } });

    const got = await setting._getSetting({ namespace: appConfig });
    assertEquals(got[0].data, { theme: "dark" });

  } finally {
    await client.close();
  }
});

Deno.test("Setting: Multiple namespaces", async () => {
  const [db, client] = await testDb();
  const setting = new SettingConcept(db);
  try {
    await setting.setSetting({ namespace: bizInfo, data: { name: "Cafe" } });
    await setting.setSetting({ namespace: appConfig, data: { version: "1.0.0" } });

    const info = await setting._getSetting({ namespace: bizInfo });
    const config = await setting._getSetting({ namespace: appConfig });

    assertEquals(info[0].data, { name: "Cafe" });
    assertEquals(config[0].data, { version: "1.0.0" });

  } finally {
    await client.close();
  }
});

Deno.test("Setting: Edge cases", async () => {
  const [db, client] = await testDb();
  const setting = new SettingConcept(db);
  try {
    // Empty data
    const res = await setting.setSetting({ namespace: bizInfo, data: {} });
    assertEquals("error" in res, true);

    // Non-existent namespace
    const got = await setting._getSetting({ namespace: "ghost" as Namespace });
    assertEquals(got[0].data, null);

    // deleteSetting (reset/rollback)
    await setting.setSetting({ namespace: bizInfo, data: { temp: true } });
    const delRes = await setting.deleteSetting({ namespace: bizInfo });
    assertEquals(delRes, { ok: true });
    const afterDel = await setting._getSetting({ namespace: bizInfo });
    assertEquals(afterDel[0].data, null);

  } finally {
    await client.close();
  }
});
