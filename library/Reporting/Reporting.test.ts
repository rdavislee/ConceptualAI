import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ReportingConcept, { Reporter, Target } from "./ReportingConcept.ts";

const reporter1 = "user:1" as Reporter;
const target1 = "post:1" as Target;

Deno.test("Reporting: Basic lifecycle", async () => {
  const [db, client] = await testDb();
  const reporting = new ReportingConcept(db);
  try {
    // 1. Submit report
    const reportRes = await reporting.report({
      reporter: reporter1,
      target: target1,
      reason: "Inappropriate content",
      details: { comment: "Spammy link" },
    });
    if ("error" in reportRes) throw new Error(reportRes.error);
    const reportId = reportRes.reportId;

    // 2. Verify pending reports
    const pending = await reporting._getPendingReports();
    assertEquals(pending[0].reports.length, 1);
    assertEquals(pending[0].reports[0].reason, "Inappropriate content");

    // 3. Resolve report
    await reporting.resolveReport({ reportId, status: "resolved" });

    // 4. Verify resolved
    const pendingAfter = await reporting._getPendingReports();
    assertEquals(pendingAfter[0].reports.length, 0);

    const report = await reporting._getReport({ reportId });
    assertEquals(report[0].report?.status, "resolved");

  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Reporting: Edge Cases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const reporting = new ReportingConcept(db);
    try {
      // Empty reason
      const err = await reporting.report({
        reporter: reporter1,
        target: target1,
        reason: "",
      });
      assertEquals("error" in err, true);

      // Invalid status for resolution
      const err2 = await reporting.resolveReport({
        reportId: "679000000000000000000000",
        status: "pending",
      });
      assertEquals("error" in err2, true);

      // Resolve non-existent
      const err3 = await reporting.resolveReport({
        reportId: "679000000000000000000000",
        status: "dismissed",
      });
      assertEquals("error" in err3, true);
    } finally {
      await client.close();
    }
  },
});
