**concept** AIPrompting [Owner]

**purpose**
run one-off AI prompts with persistent records of prompt inputs and outputs

**principle**
if an app needs to generate text or structured data from a system prompt and user prompt, then it can execute that prompt through this concept and later inspect the stored run for the prompts and output

**state**
  a set of PromptRuns with
    a promptRunId ID
    an owner Owner
    a systemPrompt? String
    a userPrompt String
    a status String
    an outputText? String
    an outputJson? Object
    an error? String

**actions**

runTextPrompt (owner: Owner, userPrompt: String, systemPrompt?: String) : (promptRunId: ID, outputText?: String, error?: String)
  **requires**
    userPrompt is not empty
  **effects**
    creates a new prompt run with a fresh promptRunId and status := "thinking"
    if prompt execution succeeds, stores status := "done" and outputText
    if prompt execution fails, stores status := "done" and error

runStructuredPrompt (owner: Owner, userPrompt: String, schema: Object, systemPrompt?: String) : (promptRunId: ID, outputJson?: Object, error?: String)
  **requires**
    userPrompt is not empty
    schema is not empty
  **effects**
    creates a new prompt run with a fresh promptRunId and status := "thinking"
    if structured prompt execution succeeds, stores status := "done" and outputJson
    if structured prompt execution fails, stores status := "done" and error

deleteRun (promptRunId: ID) : (ok: Flag)
  **requires**
    there exists a prompt run whose promptRunId is promptRunId
  **effects**
    deletes that prompt run

deleteAllRunsForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all prompt runs whose owner is owner

**queries**

_getRun (promptRunId: ID) : (promptRun: PromptRun)
  **requires**
    there exists a prompt run whose promptRunId is promptRunId
  **effects**
    returns that prompt run

_listRunsForOwner (owner: Owner) : (promptRunIds: set of ID)
  **requires** true
  **effects**
    returns the set of promptRunId values for all prompt runs owned by owner

_getLatestSuccessfulRun (owner: Owner) : (promptRunId: ID)
  **requires** true
  **effects**
    returns the promptRunId of the most recent run for owner with status "done" and no error, if one exists
