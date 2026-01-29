# SyncGenerating Agent Flow

## API Definition Phase
- Inputs: plan, concept specs, API guidelines.
- Output: OpenAPI YAML that captures user flows (not concept boundaries).
- Endpoints may touch one, many, or all concepts.

## Sync + Test Phase (per endpoint)
- Inputs: plan, endpoint spec, concept specs, and implementation map for test execution.
- Output:
  - syncs that wire Requesting.request to concept actions
  - Deno test code that calls the endpoint and asserts concept state changes

## Validation Loop
1. Compile generated sync DSL. If compilation fails, iterate on syncs.
2. Load concepts, engine, generated syncs, and tests into a temporary runtime.
3. Run Deno tests.
4. If tests fail, iterate with the same tools plus a read-concept-implementation tool.

## Tooling Expectations
- Provide the same code editing tools as the Implementing agent loop.
- Add a read-concept-implementation tool to pull in specific concept code when specs are insufficient.
