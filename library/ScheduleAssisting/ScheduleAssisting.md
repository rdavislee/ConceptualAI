**concept** ScheduleAssisting [User]

**purpose**
support AI-assisted schedule management by storing day-level schedule data and letting a scheduling agent apply natural-language scheduling requests directly to that data

**principle**
if a user creates a scheduling agent with a specific system prompt and stores schedule data for a set of days, then the user can submit a natural-language scheduling request and the agent will process it and update the stored day data accordingly

**state**
  a set of SchedulingAgents with
    a schedulingAgentId ID
    an owner User
    a systemPrompt String
    a status String

  a set of Days with
    a dayId ID
    an agent SchedulingAgent
    a date Date
    a data Object

**actions**

createSchedulingAgent (owner: User, systemPrompt: String) : (schedulingAgentId: ID)
  **requires**
    systemPrompt is not empty
  **effects**
    creates a new scheduling agent with a fresh schedulingAgentId and status "idle"

setSystemPrompt (schedulingAgentId: ID, systemPrompt: String) : (ok: Flag)
  **requires**
    there exists a scheduling agent whose schedulingAgentId is schedulingAgentId
    systemPrompt is not empty
  **effects**
    sets systemPrompt of that scheduling agent to systemPrompt

createDay (schedulingAgentId: ID, date: Date, data: Object) : (dayId: ID)
  **requires**
    there exists a scheduling agent whose schedulingAgentId is schedulingAgentId
  **effects**
    creates a new day with a fresh dayId associated with that scheduling agent

updateDay (dayId: ID, data: Object) : (ok: Flag)
  **requires**
    there exists a day whose dayId is dayId
  **effects**
    sets data of that day to data

deleteDay (dayId: ID) : (ok: Flag)
  **requires**
    there exists a day whose dayId is dayId
  **effects**
    deletes that day

deleteAllDaysForAgent (schedulingAgentId: ID) : (ok: Flag)
  **requires**
    there exists a scheduling agent whose schedulingAgentId is schedulingAgentId
  **effects**
    deletes all days associated with that scheduling agent

requestScheduleChange (schedulingAgentId: ID, request: String) : (ok?: Flag, error?: String)
  **requires**
    there exists a scheduling agent whose schedulingAgentId is schedulingAgentId
    status of that scheduling agent is "idle"
    request is not empty
  **effects**
    sets status of that scheduling agent to "busy"
    if AI processing succeeds, computes and applies the necessary updates to the stored day data for that scheduling agent
    if AI processing fails, returns error
    sets status of that scheduling agent to "idle"

deleteSchedulingAgent (schedulingAgentId: ID) : (ok: Flag)
  **requires**
    there exists a scheduling agent whose schedulingAgentId is schedulingAgentId
  **effects**
    deletes that scheduling agent and all associated days

deleteAllSchedulingAgentsForOwner (owner: User) : (ok: Flag)
  **requires** true
  **effects**
    deletes all scheduling agents whose owner is owner and all associated days

**queries**

_listSchedulingAgentsForOwner (owner: User) : (schedulingAgentIds: set of ID)
  **requires** true
  **effects**
    returns the set of schedulingAgentId values for all scheduling agents owned by owner

_getDay (dayId: ID) : (day: Day)
  **requires**
    there exists a day whose dayId is dayId
  **effects**
    returns that day

_listDaysForAgent (schedulingAgentId: ID) : (dayIds: set of ID)
  **requires**
    there exists a scheduling agent whose schedulingAgentId is schedulingAgentId
  **effects**
    returns the set of dayId values for all days associated with that scheduling agent
