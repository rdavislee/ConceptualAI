import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ScheduleAssistingConcept, { User } from "./ScheduleAssistingConcept.ts";

const user = "user:sched-1" as User;

Deno.test({
  name: "ScheduleAssisting: CRUD, AI schedule change, validation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const concept = new ScheduleAssistingConcept(db);
    try {
      const created = await concept.createSchedulingAgent({
        owner: user,
        systemPrompt: "You edit JSON schedule data only.",
      });
      assertEquals("schedulingAgentId" in created, true);
      if (!("schedulingAgentId" in created)) return;
      const schedulingAgentId = created.schedulingAgentId;

      const d1 = await concept.createDay({
        schedulingAgentId,
        date: new Date("2026-03-10T00:00:00.000Z"),
        data: { tasks: [{ title: "Task A", slot: "09:00" }] },
      });
      assertEquals("dayId" in d1, true);

      const listed = await concept._listSchedulingAgentsForOwner({ owner: user });
      assertEquals(listed.schedulingAgentIds.includes(schedulingAgentId as ID), true);

      const dayList = await concept._listDaysForAgent({ schedulingAgentId });
      assertEquals("dayIds" in dayList, true);

      await concept.deleteSchedulingAgent({ schedulingAgentId });
      const after = await concept._listSchedulingAgentsForOwner({ owner: user });
      assertEquals(after.schedulingAgentIds.includes(schedulingAgentId as ID), false);

      const created2 = await concept.createSchedulingAgent({
        owner: user,
        systemPrompt:
          "You are a schedule assistant. Return one update for the listed dayId with the full new data object.",
      });
      assertEquals("schedulingAgentId" in created2, true);
      if (!("schedulingAgentId" in created2)) return;
      const agent2 = created2.schedulingAgentId;

      const day = await concept.createDay({
        schedulingAgentId: agent2,
        date: new Date("2026-03-10T00:00:00.000Z"),
        data: {
          tasks: [{ title: "Task Alpha", slot: "09:00" }],
        },
      });
      assertEquals("dayId" in day, true);
      if (!("dayId" in day)) return;

      const beforeRow = await concept._getDay({ dayId: day.dayId });
      assertEquals("day" in beforeRow, true);
      if (!("day" in beforeRow)) return;
      const beforeJson = JSON.stringify(beforeRow.day.data ?? {});

      const res = await concept.requestScheduleChange({
        schedulingAgentId: agent2,
        request:
          `Update only dayId ${day.dayId}: set Task Alpha to slot 15:00. Return one update for that dayId.`,
      });

      assertEquals(res, { ok: true });

      const afterRow = await concept._getDay({ dayId: day.dayId });
      assertEquals("day" in afterRow, true);
      if (!("day" in afterRow)) return;
      const d = afterRow.day;

      const afterJson = JSON.stringify(d.data);
      assertEquals(afterJson !== beforeJson, true);
      assertEquals(afterJson.length > 0, true);

      const created3 = await concept.createSchedulingAgent({
        owner: user,
        systemPrompt: "Minimal edits.",
      });
      assertEquals("schedulingAgentId" in created3, true);
      if (!("schedulingAgentId" in created3)) return;

      const emptyRes = await concept.requestScheduleChange({
        schedulingAgentId: created3.schedulingAgentId,
        request: "   ",
      });
      assertEquals("error" in emptyRes, true);

      await concept.deleteAllSchedulingAgentsForOwner({ owner: user });
    } finally {
      await client.close();
    }
  },
});
