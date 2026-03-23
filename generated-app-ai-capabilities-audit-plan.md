# Generated App AI Capabilities Audit And Plan

Date: 2026-03-22

## Goal

Add first-class AI capabilities to generated apps so the concept library can support patterns such as AI conversation, document-aware agents, and AI-assisted data management, and so the generation pipeline can reliably plan, design, implement, test, sync, and assemble those apps.

This document is both:

- an audit of the current repository surfaces that matter for this work
- a phased implementation plan for shipping AI concepts safely

## Executive Summary

The repository already has strong building blocks for this effort:

- a concept-and-sync architecture that can express AI-backed application behavior
- mature DSPy prompt surfaces in planning, design, implementation, and sync generation
- sandboxed pipeline execution with request-level Gemini key injection for pipeline routes
- a small existing TypeScript AI helper in `src/utils/ai.ts`

The main gap is that AI is currently treated as a pipeline concern, not as a generated app capability. Generated backends do not yet have a standard runtime abstraction for LLM calls, generated backend templates do not expose AI env vars, generated concept tests do not receive AI credentials, and sync-generation validation currently assumes short, non-AI endpoint runtimes.

The recommended direction is:

1. Standardize generated-app LLM calls behind a TypeScript runtime wrapper with two primary call shapes: text and structured JSON.
2. Use a fixed low-cost server-side testing default of `provider=gemini` and `model=gemini-flash-latest` for concept and sync validation done on our infrastructure.
3. Add reusable AI concept primitives plus a few opinionated example concepts.
4. Update planner, designer, implementer, and sync generator prompts so AI behavior becomes a first-class design target.
5. Add test-time AI config injection and dynamic timeout policies for AI-heavy generated concepts and syncs.
6. Update assembly/templates/docs so downloaded projects are immediately ready for BYOK AI configuration, with user-editable provider/model settings.

## High-Signal Audit Findings

## Relevant Documentation

The most relevant markdown surfaces for this work are:

- `documentation/concepts-and-syncs.md`
- `documentation/getting-started-beginner.md`
- `documentation/run-generated-app-locally.md`
- `documentation/troubleshooting.md`
- `design/background/concept-design-overview.md`
- `design/background/concept-specifications.md`
- `design/background/implementing-concepts.md`
- `design/background/testing-concepts.md`
- `design/background/implementing-synchronizations.md`
- `src/concepts/Planning/Planning.md`
- `src/concepts/ConceptDesigning/ConceptDesigning.md`
- `src/concepts/Implementing/Implementing.md`
- `src/concepts/SyncGenerating/dspy/agent_flow.md`
- `src/concepts/SyncGenerating/dspy/generated_examples.md`
- `src/concepts/Assembling/Assembling.md`
- `src/concepts/Sandboxing/Sandboxing.md`
- `src/concepts/Requesting/README.md`
- `library/concept_todo_tracker.md`

Observations:

- The docs explain concepts, syncs, testing, and generated app setup well, but there is no dedicated guidance for AI-powered concepts inside generated apps.
- Current docs focus on pipeline AI usage and frontend generation AI usage more than generated backend AI capabilities.
- Generated backend runtime setup docs only cover DB/auth/request settings, not provider keys or AI feature configuration.

## Relevant Code Surfaces

The most important code surfaces are:

- `src/concepts/Planning/dspy/planner.py`
- `src/concepts/ConceptDesigning/dspy/designer.py`
- `src/concepts/Implementing/dspy/implementer.py`
- `src/concepts/Implementing/ImplementingConcept.ts`
- `src/concepts/SyncGenerating/dspy/api_generator.py`
- `src/concepts/SyncGenerating/dspy/sync_generator.py`
- `src/concepts/SyncGenerating/SyncGeneratingConcept.ts`
- `src/concepts/Assembling/AssemblingConcept.ts`
- `src/concepts/Requesting/RequestingConcept.ts`
- `src/concepts/Sandboxing/SandboxingConcept.ts`
- `src/utils/ai.ts`
- `src/tests/implementing_sync.test.ts`
- `src/tests/sync_generating.test.ts`
- `src/tests/assembling.test.ts`
- `src/concepts/Assembling/templates/.env.template`
- `.env.template`

## Current-State Findings

### 1. There is no generated-app AI runtime standard yet

`src/utils/ai.ts` already provides a provider-agnostic helper for OpenAI-compatible, Anthropic, Gemini, and xAI structured calls, but it is not the standard runtime used by generated concepts today.

Implication:

- generated AI concepts would currently have no canonical pattern to follow
- prompts would likely invent raw provider HTTP calls inconsistently
- tests would be harder to standardize

### 2. The pipeline prompt surfaces are strong but not AI-concept-aware

The planner, designer, implementer, API generator, and sync generator all have rich prompt instructions, but they currently optimize for CRUD-style data concepts and sync orchestration more than AI-native behaviors.

Missing prompt concerns include:

- AI interaction mode: chat, completion, extraction, classification, document-aware context use, automation
- grounding sources and document context inputs
- provenance and citation requirements
- latency and timeout expectations
- model/provider configuration
- human review loops for AI-generated actions
- fallback behavior when AI calls fail

### 3. Generated app templates do not expose AI configuration

The generated backend template at `src/concepts/Assembling/templates/.env.template` only contains DB/auth/request settings. There are no commented provider keys, no generic AI provider/model config, and no AI-specific timeout settings.

Implication:

- downloaded projects are not ready for AI-backed concepts
- users must reverse-engineer hidden env needs

### 4. Test runners are not prepared for AI-backed generated concepts

Implementation testing:

- `src/concepts/Implementing/ImplementingConcept.ts` only injects `DB_NAME` into generated concept tests
- `src/concepts/Implementing/dspy/implementer.py` uses fixed subprocess timeouts such as 60 seconds for `deno test`

Sync-generation validation:

- `src/concepts/SyncGenerating/dspy/sync_generator.py` hardcodes `REQUESTING_TIMEOUT=10000`
- cleanup timeout is 10 seconds
- endpoint `deno test` timeout is 30 seconds
- LLM generation timeout for an endpoint bundle is 240 seconds

Implication:

- any generated concept or endpoint that performs live LLM calls is likely to fail or hang under current defaults
- there is no clear distinction yet between low-cost server-side validation settings and user-configurable generated-app runtime settings

### 5. Request-level AI injection exists, but only for pipeline Gemini usage

`src/concepts/Requesting/RequestingConcept.ts` already extracts:

- `X-Gemini-Api-Key`
- `X-Gemini-Tier`

This is only wired as validation for pipeline/build routes, not as a general generated-app AI runtime contract.

Implication:

- generated apps do not yet have a generic BYOK request contract
- provider support is asymmetric

### 6. Sandboxing forwards Gemini credentials, but not a complete AI runtime contract

`src/concepts/Sandboxing/SandboxingConcept.ts` passes Gemini key/tier and some environment through to sandbox containers, and because the sandbox runs the repository code it likely already has access to `src/utils/ai.ts` as part of that runtime. That means the sandbox can probably support the intended internal testing path of using the injected Gemini credentials together with the shared TypeScript AI wrapper.

So the main gap is narrower than originally stated. The problem is less "the sandbox lacks AI runtime code" and more:

- the internal Gemini-based testing contract should be documented explicitly
- the generated-app runtime contract should still be made explicit for downloaded apps
- if non-Gemini server-side overrides are ever needed later, those would still need a clear forwarding policy

### 7. The concept library currently has useful adjacent concepts, but no AI concept family

There are good foundations like:

- `library/Messaging/Messaging.md`
- `library/Scheduling/Scheduling.md`
- `library/Events/Events.md`
- `library/MediaHosting/MediaHosting.md`

But there is no AI concept family for:

- conversation
- document-aware context handling
- embeddings/indexing
- AI task execution
- AI-assisted schedule management

### 8. `HEADLESS_URL` is overloaded and should be cleaned up before this grows

This finding needs correction. Based on `library_API.md`, `HEADLESS_URL` is the URL of the headless concept server that hosts the concept library API used by design and implementation retrieval.

The real issue is that the comment in the root `.env.template` is misleading, because it describes `HEADLESS_URL` as a Browserless/headless-browser endpoint for frontend generation.

Recommendation:

- correct `.env.template` and any related docs so `HEADLESS_URL` is clearly documented as the concept-library server URL
- if frontend generation needs a browserless service URL, give that its own distinct env var rather than overloading `HEADLESS_URL`

### 9. The concept library API is an external dependency boundary

Designing and implementing consume concept specs through HTTP (`/api/specs`, `/api/pull/...`). The hosted concept library service is still an external dependency boundary at runtime, but the `library/` folder in this repo reflects the concepts that live in that concept library.

Implication:

- adding AI concepts is not only a prompt/codegen task
- the `library/` folder is the local authoring surface for these concepts
- after new AI concepts are created in `library/`, they should be uploaded/published to the hosted concept library service so design and implementation can retrieve them

## Recommended Architecture Direction

## A. Standardize LLM Calls In TypeScript

Recommendation: keep a repo-owned TypeScript wrapper for generated apps, centered around two simple primitives:

- one function for text output
- one function for structured JSON output

The simplest path is likely to evolve `src/utils/ai.ts` into that official wrapper rather than immediately replacing it.

Open-source alternatives that could sit underneath that wrapper if needed:

- primary recommendation: Vercel AI SDK
- secondary option if agent graphs become central later: LangChain JS or LangGraph

Why this shape fits the repo:

- it matches what `src/utils/ai.ts` already roughly does
- it keeps prompts simple because generated concepts only need to choose between text and structured output
- it reduces maintenance risk because generated concepts do not depend directly on vendor SDKs
- it still allows swapping implementation later without changing generated concept code

Why Vercel AI SDK is the best open-source fit if you do not want to maintain provider adapters yourself:

- strong provider-agnostic model selection
- good structured output support
- TypeScript-first ergonomics
- good fit for concept implementations that need predictable object output
- can live under a local wrapper so generated concepts are not coupled directly to the SDK

Recommended repo approach:

- promote `src/utils/ai.ts` or a close successor into the official generated-app wrapper
- expose only a minimal surface like `generateText` and `generateObject`
- generated concepts should call the local wrapper, not provider SDKs directly
- prompts should instruct the implementer to never hand-roll provider HTTP calls unless the wrapper lacks a required feature

## A1. Provider Policy For Testing vs Generated Apps

Use two different operating modes:

- server-side testing mode: always use `provider=gemini`
- server-side testing model: always use `gemini-flash-latest`
- generated app runtime mode: user-editable `AI_PROVIDER` and `AI_MODEL` in the downloaded app `.env`

Rationale:

- keeps server-side concept and sync testing cheap
- gives downloaded apps provider flexibility
- keeps pipeline behavior predictable during concept and sync validation

Recommended default behavior:

- internal server-side concept tests and sync tests should force Gemini Flash even if the generated app runtime contract is provider-agnostic
- generated backend `.env.template` should still default to Gemini-based values for ease of first run, but users can change them freely after download

## B. Do Not Put The LM In Persistent Concept State

The current concept model treats state as business/domain state stored in MongoDB. Model/provider config is runtime infrastructure, not domain state.

Recommendation:

- do not add `lm` to persisted concept state
- do not encode raw provider clients into concept specs
- instead, provide a runtime `AIConfig` or `AIContext` input path

Preferred patterns:

- environment default for production and downloaded apps
- fixed internal server-side test config for repository-controlled validation
- optional request-level override for testing and BYOK flows when explicitly needed
- explicit action/query parameters when a concept method needs custom AI behavior

## C. Add A Shared AI Runtime Contract

Introduce a generated-backend runtime abstraction such as:

- `AIProvider`
- `AIModelRef`
- `AIConfig`
- `AIUsage`
- `AIResult<T>`
- `EmbeddingResult`
- `AIError`

Capabilities the wrapper should expose:

- `generateObject`
- `generateText`
- `embedText`
- optional streaming support later
- retries and timeout handling
- structured logging with secret redaction
- provider/model fallback policy

Non-goal for V1:

- evaluating semantic quality deeply during server-side tests

The server-side testing contract should stay loose:

- string-returning calls should only need to return a non-empty string or a valid domain-specific string form
- JSON-returning calls should only need to return valid data matching the requested structure
- tests should focus on shape, parseability, and non-crashing behavior, not subjective answer quality

## D. Keep AI Concepts Small And Composable

Avoid a single giant `AIAgent` concept.

At the same time, avoid over-fragmenting the concept library into too many tiny AI sub-concepts when a higher-level concept is easier for the generator to use correctly.

Recommended balance:

- keep `AIConversation`, `AIPrompting`, `ScheduleAssisting`, and `AIClassification` as clear first-class concepts
- allow a document-aware agent concept that can hold documents in context and answer with awareness of them, without trying to introduce full RAG infrastructure in this phase
- use additional concepts such as `AIExtraction` or `AIModeration` where they represent common standalone app capabilities

This fits the repo's existing concept philosophy while also keeping the library practical for prompt selection and generated implementation.

## Proposed AI Concept Library

## Recommended Initial Concepts

Recommended first-class concepts for the initial AI library:

- `AIConversation`
- `AIPrompting`
- `DocumentAwareAgent`
- `ScheduleAssisting`
- `AIClassification`
- `AIExtraction`
- `AIModeration`

Strong later candidates:

- `AIRecommendation`
- `VoiceTranscription`
- `AIImageGeneration`

## Draft AI Concept Specs For Review

These are draft specs written directly in this file for review before creating concept files under `library/`.

### `AIConversation`

**concept** AIConversation [User]

**purpose**
support conversational AI interactions with persistent threads whose stored history grows with each user-assistant exchange

**principle**
if a conversation is opened and a participant sends a message, then the system stores that message, generates the assistant's string reply, and adds it to the same conversation so the full exchange can be retrieved later

**state**
  a set of Conversations with
    a conversationId ID
    an owner User
    a systemPrompt? String
    a status String
    a messages List of Objects { role: String, content: String }

**actions**

createConversation (owner: User, systemPrompt?: String) : (conversationId: ID)
  **requires** true
  **effects**
    creates a new conversation with a fresh conversationId, status "idle", messages := []

setSystemPrompt (conversationId: ID, systemPrompt: String) : (ok: Flag)
  **requires**
    there exists a conversation whose conversationId is conversationId
  **effects**
    sets systemPrompt of that conversation to systemPrompt

sendMessage (conversationId: ID, role: String, content: String, instructions?: String, context?: Object) : (reply?: String, error?: String)
  **requires**
    there exists a conversation whose conversationId is conversationId
    status of that conversation is "idle"
    role is not empty
    content is not empty
  **effects**
    sets status of that conversation to "thinking"
    appends a message with role := role and content := content to messages of that conversation
    if AI reply generation succeeds, appends an assistant message with role "assistant" and content := reply to messages of that conversation
    if AI reply generation fails, returns error and does not append an assistant message
    sets status of that conversation to "idle"

deleteConversation (conversationId: ID) : (ok: Flag)
  **requires**
    there exists a conversation whose conversationId is conversationId
  **effects**
    deletes that conversation

deleteAllConversationsForOwner (owner: User) : (ok: Flag)
  **requires** true
  **effects**
    deletes all conversations whose owner is owner

**queries**

_getConversation (conversationId: ID) : (conversation: Conversation)
  **requires**
    there exists a conversation whose conversationId is conversationId
  **effects**
    returns that conversation

_listConversationsForOwner (owner: User) : (conversationIds: set of ID)
  **requires** true
  **effects**
    returns the set of conversationIDs for all conversations owned by owner

### `AIPrompting`

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

### `DocumentAwareAgent`

**concept** DocumentAwareAgent [Owner]

**purpose**
support AI agent interactions over a bounded set of in-context documents without requiring full retrieval infrastructure

**principle**
if a user creates a document-aware agent, adds documents to it while capacity remains, and then asks a question, the agent answers using its currently held document context; if the user tries to add more document content than the agent can hold, the addition is rejected

**state**
  a set of DocumentAwareAgents with
    a documentAwareAgentId ID
    an owner Owner
    a name String
    an instructions? String
    a maxContextSize Number

  a set of Documents with
    an agent DocumentAwareAgent
    a documentId ID
    a title String
    a content String
    a metadata? Object

**actions**

createAgent (owner: Owner, name: String, maxContextSize: Number, instructions?: String) : (documentAwareAgentId: ID)
  **requires**
    name is not empty
    maxContextSize > 0
  **effects**
    creates a new document-aware agent with a fresh documentAwareAgentId

renameAgent (documentAwareAgentId: ID, name: String) : (ok: Flag)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
    name is not empty
  **effects**
    sets name of that document-aware agent to name

updateInstructions (documentAwareAgentId: ID, instructions: String) : (ok: Flag)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
  **effects**
    sets instructions of that document-aware agent to instructions

addDocument (documentAwareAgentId: ID, title: String, content: String, metadata?: Object) : (documentId?: ID, error?: String)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
    title is not empty
    content is not empty
  **effects**
    if adding the document would keep the total held document context within maxContextSize, creates a new document with a fresh documentId
    if adding the document would exceed maxContextSize, returns error and does not add the document

deleteDocument (documentId: ID) : (ok: Flag)
  **requires**
    there exists a document whose documentId is documentId
  **effects**
    deletes that document

deleteAllDocuments (documentAwareAgentId: ID) : (ok: Flag)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
  **effects**
    deletes all documents associated with that document-aware agent

deleteAgent (documentAwareAgentId: ID) : (ok: Flag)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
  **effects**
    deletes that document-aware agent and all documents associated with it

deleteAllAgentsForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all document-aware agents whose owner is owner and all documents associated with them

**queries**

_listAgentsForOwner (owner: Owner) : (documentAwareAgentIds: set of ID)
  **requires** true
  **effects**
    returns the set of documentAwareAgentId values for all document-aware agents owned by owner

_getDocuments (documentAwareAgentId: ID) : (documentIds: set of ID)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
  **effects**
    returns the set of documentId values for all documents associated with that document-aware agent

_answer (documentAwareAgentId: ID, question: String) : (answer: String)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
    question is not empty
  **effects**
    returns an answer generated using the documents currently held by that document-aware agent

_answerStructured (documentAwareAgentId: ID, question: String, schema: Object) : (answerJson: Object)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
    question is not empty
    schema is not empty
  **effects**
    returns a structured answer matching schema using the documents currently held by that document-aware agent

### `ScheduleAssisting`

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

### `AIClassification`

**concept** AIClassification [Owner, Item]

**purpose**
assign AI-generated labels or categories to items and persist the results for later filtering, review, and reuse

**principle**
if an app defines a classifier and submits an item's content to it, then the concept returns a classification result and stores the chosen label and status so the app can later retrieve or filter by that result

**state**
  a set of Classifiers with
    a classifierId ID
    an owner Owner
    a name String
    a labels Object
    an instructions? String

  a set of ClassificationResults with
    a classificationResultId ID
    a classifier Classifier
    an item Item
    a label String
    a status String

**actions**

createClassifier (owner: Owner, name: String, labels: Object, instructions?: String) : (classifierId: ID)
  **requires**
    name is not empty
    labels is not empty
  **effects**
    creates a new classifier

updateClassifier (classifier: Classifier, labels?: Object, instructions?: String) : (ok: Flag)
  **requires**
    classifier exists
  **effects**
    updates labels and/or instructions of classifier

classify (classifier: Classifier, item: Item, content: String) : (classificationResultId?: ID, label?: String, error?: String)
  **requires**
    classifier exists
    content is not empty
  **effects**
    if classification succeeds, creates a new classification result for item with label and status := "done"
    if classification fails, returns error and does not create a classification result

deleteClassificationResult (classificationResultId: ID) : (ok: Flag)
  **requires**
    there exists a classification result whose classificationResultId is classificationResultId
  **effects**
    deletes that classification result

deleteAllClassificationResultsForClassifier (classifier: Classifier) : (ok: Flag)
  **requires**
    classifier exists
  **effects**
    deletes all classification results associated with that classifier

deleteClassifier (classifierId: ID) : (ok: Flag)
  **requires**
    there exists a classifier whose classifierId is classifierId
  **effects**
    deletes that classifier and all classification results associated with it

deleteAllClassifiersForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all classifiers whose owner is owner and all classification results associated with them

**queries**

_getLatestClassification (classifier: Classifier, item: Item) : (classificationResult: ClassificationResult)
  **requires** true
  **effects**
    returns the most recent classification result for item under classifier, if one exists

_getItemsByLabel (classifier: Classifier, label: String) : (classificationResults: set of ClassificationResult)
  **requires** true
  **effects**
    returns all classification results under classifier whose label is label

_listClassifiersForOwner (owner: Owner) : (classifierIds: set of ID)
  **requires** true
  **effects**
    returns the set of classifierIds for all classifiers owned by owner

### `AIExtraction`

**concept** AIExtraction [Owner]

**purpose**
extract structured information from unstructured content using reusable schemas and persistent extractor state

**principle**
if an app defines an extraction schema and submits some text content, then the concept returns structured data matching that schema and stores the latest input, output, status, and error on the extractor

**state**
  a set of Extractors with
    an extractorId ID
    an owner Owner
    a name String
    a schema Object
    an instructions? String
    a status String
    an input String
    an outputJson? Object
    an error? String

**actions**

createExtractor (owner: Owner, name: String, schema: Object, instructions?: String) : (extractorId: ID)
  **requires**
    name is not empty
    schema is not empty
  **effects**
    creates a new extractor

extract (extractor: Extractor, content: String) : (outputJson?: Object, error?: String)
  **requires**
    extractor exists
    content is not empty
  **effects**
    sets status of extractor := "thinking"
    sets input of extractor := content
    if extraction succeeds, stores status := "done" and outputJson
    if extraction fails, stores status := "done" and error

deleteExtractor (extractorId: ID) : (ok: Flag)
  **requires**
    there exists an extractor whose extractorId is extractorId
  **effects**
    deletes that extractor

deleteAllExtractorsForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all extractors whose owner is owner

**queries**

_getExtractor (extractorId: ID) : (extractor: Extractor)
  **requires**
    there exists an extractor whose extractorId is extractorId
  **effects**
    returns that extractor

_listExtractorsForOwner (owner: Owner) : (extractorIds: set of ID)
  **requires** true
  **effects**
    returns the set of extractorIds for all extractors owned by owner

### `AIModeration`

**concept** AIModeration [Owner, Item]

**purpose**
screen content or items against moderation policies and persist moderation decisions for review and enforcement

**principle**
if an app defines a moderation policy and submits an item's content, then the concept returns a moderation verdict and stores the result so the app can later review flagged items or enforce workflow rules

**state**
  a set of ModerationPolicies with
    a moderationPolicyId ID
    an owner Owner
    a name String
    a policyText String

  a set of ModerationResults with
    a moderationResultId ID
    a policy ModerationPolicy
    an item Item
    a verdict? Boolean
    a rationale? String
    a status String

**actions**

createPolicy (owner: Owner, name: String, policyText: String) : (moderationPolicyId: ID)
  **requires**
    name is not empty
    policyText is not empty
  **effects**
    creates a moderation policy

moderate (policy: ModerationPolicy, item: Item, content: Object) : (moderationResultId?: ID, verdict?: Boolean, error?: String)
  **requires**
    policy exists
    content is not empty
  **effects**
    if moderation succeeds, creates a moderation result for item with verdict, optional rationale, and status := "done"
    if moderation fails, returns error and does not create a moderation result

deleteModerationResult (moderationResultId: ID) : (ok: Flag)
  **requires**
    there exists a moderation result whose moderationResultId is moderationResultId
  **effects**
    deletes that moderation result

deleteAllModerationResultsForPolicy (policy: ModerationPolicy) : (ok: Flag)
  **requires**
    policy exists
  **effects**
    deletes all moderation results associated with that policy

deletePolicy (moderationPolicyId: ID) : (ok: Flag)
  **requires**
    there exists a moderation policy whose moderationPolicyId is moderationPolicyId
  **effects**
    deletes that moderation policy and all moderation results associated with it

deleteAllPoliciesForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all moderation policies whose owner is owner and all moderation results associated with them

**queries**

_getLatestModeration (policy: ModerationPolicy, item: Item) : (moderationResult: ModerationResult)
  **requires** true
  **effects**
    returns the most recent moderation result for item under policy, if one exists

_getFlaggedItems (policy: ModerationPolicy) : (moderationResults: set of ModerationResult)
  **requires** true
  **effects**
    returns all moderation results under policy whose verdict indicates non-passing or flagged content

_listPoliciesForOwner (owner: Owner) : (moderationPolicyIds: set of ID)
  **requires** true
  **effects**
    returns the set of moderationPolicyIds for all moderation policies owned by owner

## Document-Aware Agent Recommendation

For this phase, prefer a simpler document-aware agent instead of implementing full RAG.

Recommended direction:

- keep documents as explicit concept state
- allow the agent to answer using only the currently held document context
- reject document additions when the held context would exceed the agent's configured limit
- avoid embeddings, retrieval indexes, reranking, vector stores, or chunk management in this initiative

Implementation consequence:

- this concept should work on top of the existing LM runtime rather than requiring separate retrieval infrastructure
- if richer retrieval is ever needed later, it can be introduced as a future concept or a later revision instead of being part of this plan

## Phased Delivery Plan

## Phase 0. Architecture Cleanup And Decision Record

Goal:

- make a few foundation decisions before touching prompts heavily

Tasks:

- decide whether to formalize `src/utils/ai.ts` directly or wrap an OSS SDK behind the same two-function interface
- decide the generated-app runtime contract for AI config
- decide and document the fixed internal testing config: `provider=gemini`, `model=gemini-flash-latest`
- split ambiguous environment variables such as `HEADLESS_URL`
- define security rules for BYOK request-time credentials
- define when AI features run synchronously vs as background jobs

Likely files:

- `.env.template`
- `src/utils/ai.ts`
- `src/concepts/Requesting/RequestingConcept.ts`
- `src/concepts/Sandboxing/SandboxingConcept.ts`
- docs in `documentation/`

Exit criteria:

- one agreed runtime abstraction
- one agreed config shape
- one agreed server-side testing policy
- one agreed credential policy

## Phase 1. Generated-App AI Runtime Foundation

Goal:

- make generated backends capable of standardized AI calls

Tasks:

- upgrade `src/utils/ai.ts` or replace it with a close successor while preserving a very small wrapper surface
- add provider/model/timeouts/retry config support
- add embeddings support
- add secret redaction and structured telemetry
- define a generic AI context shape usable by generated concepts
- ensure assembly copies the runtime support into generated apps

Likely files:

- `src/utils/ai.ts`
- `src/concepts/Assembling/AssemblingConcept.ts`
- `src/concepts/Assembling/templates/.env.template`
- possibly `src/utils/types.ts`

Important implementation rules:

- generated concepts should import the local wrapper, not raw provider SDK clients
- the wrapper should make the low-level provider choice invisible to generated concept code
- the wrapper API should stay close to `generateText` and `generateObject` so prompts remain easy to control

## Phase 2. AI Concept Library V1

Goal:

- create reusable AI concepts that the designer and implementer can target

Tasks:

- author initial AI concept specs in `library/`
- implement reference TypeScript concept classes and tests
- publish them through the concept-library API path used by design/implementation
- add example app-facing compositions

Likely files:

- new folders under `library/`
- concept library publishing/indexing code or service config
- `library/concept_todo_tracker.md`

Important design rules:

- include provenance fields
- include explicit queries that keep syncs thin
- include bulk cleanup actions where generated artifacts need cascading deletes
- include failure/status metadata for long-running AI actions

## Phase 3. Planning And Designing Prompt Updates

Goal:

- make the plan/design stages reliably use AI capabilities when the user request and plan call for them, without over-correcting the existing abstractions

Tasks for planner:

- keep planner changes minimal because `planner.py` is already intentionally abstracted away from concrete concepts and syncs
- add a small amount of prompt guidance reminding the planner that AI capabilities exist in the concept library and should be included when the user explicitly asks for them
- avoid turning the planner into a concept-aware or sync-aware stage beyond that light reminder

Tasks for designer:

- keep designer prompt changes targeted rather than broad
- do not tell `designer.py` to prefer AI concepts in general; tell it to use AI library concepts when the plan actually calls for AI capabilities
- rely primarily on strong AI library specs in designer context so the designer can infer usage from examples rather than from heavy prompt instructions
- add only a small amount of prompt guidance for custom AI concepts and for separating reusable AI concerns instead of collapsing everything into one large custom concept
- where appropriate, encourage composition of AI library concepts with other concepts rather than inventing overly broad custom AI concepts

Likely files:

- `src/concepts/Planning/dspy/planner.py`
- `src/concepts/ConceptDesigning/dspy/designer.py`
- `design/background/concept-specifications.md`
- `design/background/concept-design-overview.md`

Exit criteria:

- planner can produce AI-aware plans
- designer can select AI library concepts and produce coherent custom AI concept specs

## Phase 4. Implementer Prompting And Generated Code Patterns

Goal:

- make generated AI concepts implementable and consistent, with most of the leverage coming from references, runtime wiring, and test behavior rather than large prompt rewrites

Tasks:

- keep implementer prompt changes minimal
- do not rely on prompt text to require the shared AI runtime wrapper; instead, ensure the wrapper is present in the agent context and in the test repositories so the implementer naturally uses it
- rely heavily on AI library concept implementations and tests as references
- keep a small amount of prompt guidance for loose AI-output testing so generated tests validate structure and non-empty outputs rather than semantic gold answers
- focus the real implementation effort here on getting AI concept testing, context setup, and reference concepts correct

Likely files:

- `src/concepts/Implementing/dspy/implementer.py`
- `src/concepts/Implementing/ImplementingConcept.ts`
- `design/background/implementing-concepts.md`
- `design/background/testing-concepts.md`

Important generated-code conventions:

- all AI actions should be explicitly typed
- model output should be schema-validated when JSON is expected
- AI errors should map to concept-level error results, not ad hoc thrown strings
- concepts should separate domain persistence from prompt-building logic
- concept tests should usually assert structure and successful execution, not brittle prompt-quality expectations

## Phase 5. Sync Generation, API Design, And AI Endpoint Strategy

Goal:

- allow generated APIs and syncs to expose AI behavior reliably, with the main work focused on sync patterns/examples and only light sync-generator prompting

Tasks:

- keep `api_generator.py` changes minimal unless concrete failures show up in testing; the current abstraction may already be sufficient for deriving endpoints from the plan and selected concepts
- focus on sync-generation changes
- teach sync generation how to pass AI config into concept actions
- keep sync-generator prompt additions minimal
- add only the most important AI-specific guidance to generation and review:
- do not test the semantics of open-ended natural-language outputs from AI concepts
- do test deterministic outputs where the concept semantics are crisp, such as classification labels
- do test structured outputs against the expected response shape and `api.yaml` contract

Likely files:

- `src/concepts/SyncGenerating/dspy/sync_generator.py`
- `src/concepts/SyncGenerating/dspy/generated_examples.md`
- `design/background/implementing-synchronizations.md`

Recommended API policy:

- short AI calls may stay synchronous
- long-running AI operations should use job-oriented endpoints
- chat streaming can be a later phase unless a concrete product need appears immediately

## Phase 6. Test Infrastructure, API Key Injection, And Dynamic Timeouts

Goal:

- make AI-backed generated concepts and syncs testable, with explicit control over which endpoints need AI-aware validation budgets

Tasks for implementation testing:

- let `ImplementingConcept.runTests` pass AI env vars into generated concept tests
- force server-side generated concept tests to use `provider=gemini` and `model=gemini-flash-latest`
- support generic AI env keys plus provider-specific keys for downloaded app runtime compatibility
- keep AI concept tests relatively loose and shape-based
- add dynamic test timeouts based on AI concept presence

Tasks for sync-generation validation:

- let generated endpoint tests receive AI env vars and optional request-level BYOK headers where needed
- force server-side sync validation to use `provider=gemini` and `model=gemini-flash-latest`
- during relevant concept selection, mark whether an endpoint touches AI concepts
- use that AI-touching signal to allocate longer validation/test budgets only where needed
- replace fixed validation timeouts with configurable dynamic timeouts
- raise `REQUESTING_TIMEOUT` when AI endpoints are being validated
- keep AI endpoint assertions focused on response structure, status, and parseability

Suggested timeout knobs:

- `GENERATED_AI_CALL_TIMEOUT_MS`
- `GENERATED_CONCEPT_TEST_TIMEOUT_MS`
- `GENERATED_SYNC_TEST_TIMEOUT_MS`
- `GENERATED_AI_VALIDATION_TIMEOUT_MS`

Likely files:

- `src/concepts/Implementing/ImplementingConcept.ts`
- `src/concepts/Implementing/dspy/implementer.py`
- `src/concepts/SyncGenerating/dspy/sync_generator.py`
- `src/concepts/Requesting/RequestingConcept.ts`
- relevant integration tests in `src/tests/`

Important policy:

- never persist request-injected API keys in MongoDB
- redact them from logs
- prefer fixed Gemini Flash config for internal server-side validation
- prefer env defaults for downloaded apps and live usage
- use request injection mainly for tests, sandboxes, and explicit BYOK product flows

## Phase 7. Assembly, Templates, And Downloaded Project UX

Goal:

- make downloaded projects AI-ready out of the box

Tasks:

- add AI env placeholders to generated backend `.env.template`
- update generated README content to explain AI config
- optionally generate commented examples for common providers
- document BYOK vs server-managed key modes
- ensure generated zips include any new runtime helpers

Likely files:

- `src/concepts/Assembling/templates/.env.template`
- `src/concepts/Assembling/AssemblingConcept.ts`
- `src/concepts/Assembling/dspy/doc_generator.py`
- `documentation/run-generated-app-locally.md`

Recommended generated backend env additions:

- `AI_PROVIDER` with a default such as `gemini`
- `AI_MODEL` with a default such as `gemini-flash-latest`
- `AI_TIMEOUT_MS`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `XAI_API_KEY`

## Phase 8. QA, Prompt Tuning, And Example App Regression Suite

Goal:

- prove AI concepts work end-to-end

Tasks:

- add golden example prompts for AI-enabled app requests
- create at least three regression apps:
- AI chat app
- document-aware knowledge assistant
- AI-managed schedule/planner app
- verify planning through assembly with real credentials in sandbox
- add lower-cost mock or fixture mode for CI
- treat prompt tuning as secondary to good AI library specs, references, and runtime/test infrastructure
- only add or adjust prompt text after concrete failures appear in the regression suite

Likely files:

- `src/tests/implementing_sync.test.ts`
- `src/tests/sync_generating.test.ts`
- `src/tests/assembling.test.ts`
- new manual fixtures under sync-generating test assets

## Prompt Update Checklist By Stage

## Planner

Add instructions to capture:

- whether the app has conversational AI, document-aware agent behavior, recommendations, automation, or extraction
- a light reminder that AI capabilities exist in the library and should be included when the user asks for them

## Designer

Add instructions to require:

- AI library concept selection when the plan actually calls for AI capabilities
- separation of reusable AI concerns instead of broad custom concept mashups
- only small targeted prompt additions, with most behavior driven by the quality of AI concept specs in context

## Implementer

Add instructions to require:

- loose test expectations centered on structure and non-empty outputs
- any small prompt additions here should support testing behavior, not try to replace good reference concepts and runtime context

## Sync Generator

Add instructions to require:

- AI config plumbing from request or env to concept methods
- endpoint classification for whether an endpoint touches AI concepts
- correct timeout behavior for AI-touching endpoints
- endpoint tests that cover AI-failure and missing-key paths

## Concrete Additional Issues To Fold Into This Work

- split `HEADLESS_URL` into clearer env names
- align generated README text with actual env names such as `MONGODB_URL`
- decide whether `src/utils/ai.ts` is promoted directly, lightly refactored, or backed by an OSS SDK under the hood
- define a concept-library publishing workflow for new AI concepts
- decide whether BYOK is a product feature for generated apps or only a testing/sandbox affordance

## Recommended Sequence Of Execution

If bandwidth is limited, the best implementation order is:

1. Phase 0 and Phase 1
2. Phase 2
3. Phase 3 and Phase 4
4. Phase 5 and Phase 6
5. Phase 7 and Phase 8

This order prevents prompt work from racing ahead of runtime/test infrastructure.

## Proposed Success Criteria

This initiative should be considered successful when:

- a user can request an AI conversation app, a document-aware agent app, or an AI scheduling app and the planner/design stages model it correctly
- the designer can pull AI library concepts or generate AI custom concepts coherently
- the implementer generates concepts that use a shared TS AI runtime pattern
- sync generation can produce working AI endpoints and tests
- generated backend zips include clear AI env configuration
- example apps can be generated end-to-end in sandbox with real credentials

## Bottom-Line Recommendation

Proceed with this as a structured multi-phase program, not as a prompt-only update.

The most important near-term decision is to standardize generated-app AI calls behind a very small TypeScript wrapper, likely by formalizing `src/utils/ai.ts` or replacing it with a compatible local module that exposes `generateText` and `generateObject`. Under the hood, that wrapper can stay custom or adopt an open-source provider layer such as Vercel AI SDK. Once that exists, the rest of the work becomes much more tractable: AI concept library authoring, prompt updates, cheap Gemini Flash-based server-side validation, timeout handling, and generated project UX can all converge on one runtime model instead of fragmenting across providers and stages.
