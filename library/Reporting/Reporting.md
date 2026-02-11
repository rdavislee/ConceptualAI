**concept** Reporting [Reporter, Target, Report]

**purpose**
Enables users to flag content or other users for moderation review, ensuring a safe and compliant environment.

**principle**
A reporter submits a report against a target with a reason; moderators can then retrieve pending reports and mark them as resolved or dismissed.

**state**
  a set of Reports with
    a reporter (Reporter)
    a target (Target)
    a reason String
    a details? Object
    a status String (e.g., "pending", "resolved", "dismissed")
    a createdAt DateTime
    a updatedAt DateTime

**actions**

report (reporter: Reporter, target: Target, reason: String, details?: Object) : (reportId: Report)
  **requires**
    reason is not empty
  **effects**
    creates a new report with status "pending", createdAt := now, updatedAt := now

resolveReport (reportId: Report, status: String) : (ok: Flag)
  **requires**
    report exists, status is one of "resolved", "dismissed"
  **effects**
    updates the report's status and set updatedAt := now

**queries**

_getPendingReports () : (reports: Set<Report>)
  **requires** true
  **effects** returns all reports with status "pending", oldest first

_getReport (reportId: Report) : (report: Report | null)
  **requires** true
  **effects** returns the report data, or null if it doesn't exist
