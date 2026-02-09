# Frontend Review/Fix Loop

This document describes the full frontend generation review/fix loop used by
`generate_frontend.ts`, end-to-end. It is not limited to changes made in this
conversation.

## Overview

After the initial LLM generation, the system runs a structured pipeline to
validate the frontend, repair build errors, and verify semantic correctness
against the app graph and OpenAPI spec. The loop is designed to converge on a
buildable, behaviorally correct frontend before producing the zip artifact.

The loop is composed of **Phases 1–6** plus a **Final Gate** build:

1. **Phase 1: Initial Build Check**
2. **Phase 2: Route Mapping**
3. **Phase 3: Missing Page Generation (if needed)**
4. **Phase 4: Full Node Review (parallelized)**
5. **Phase 5: Per-Node Fix Loop**
6. **Phase 6: Build Check**
7. **Final Gate: `vite build`**

Phases 1–3 run once up front. Phases 4–6 are wrapped in an outer loop with a
max iteration cap to avoid infinite retries.

## Phase 1: Initial Build Check

- Runs `npm install --ignore-scripts` (first pass only).
- Runs `npx tsc -p tsconfig.app.json --noEmit`.
- On failures, extracts file paths and error output.
- Calls the **Build Fixer** LLM with:
  - The TypeScript error output.
  - The broken files.
  - Shared context files (types, api helpers, auth context).
- Applies `<dyad-write>` patches to repair build errors.
- Repeats up to 3 times or until the build passes.

## Phase 2: Route Mapping

- Uses Gemini Flash with `generateObject` to map app graph nodes to routes.
- Inputs: `App.tsx` source + app graph node list.
- Output: `{ nodeId, componentName, filePath }` for each node.
- Validates that mapped files exist; missing files are marked `unmapped`.

## Phase 3: Missing Page Generation

If any nodes are unmapped:

- Calls the **Missing Page Generator** LLM with:
  - Unmapped nodes + edges.
  - Shared context files.
  - OpenAPI spec.
- Generates missing page files and updates `App.tsx` routing.
- Runs a build check and (if needed) build fixes.
- Re-runs route mapping to ensure all nodes are mapped.

## Phases 4–6 Outer Loop (max 3 iterations)

The core review/fix loop is:

```
for outerIter = 0..2:
    Phase 4: Review ALL nodes (parallel).
    Phase 5: If any nodes failed → per-node fix loop.
             If all nodes passed → skip.
    Phase 6: Build check (up to 3 fix attempts). Always runs.
             If build fixer modified files → continue (back to Phase 4).
             If build passed cleanly → break to Final Gate.
```

### Phase 4: Full Node Review

- Each app graph node is reviewed in a focused LLM call.
- Inputs per node:
  - Node definition + outgoing edges.
  - Node page source file.
  - Shared context files (App.tsx, api.ts, types.ts, AuthContext if present).
  - Full OpenAPI YAML spec.
- Output: structured JSON via Zod schema:
  - `verdict: "pass" | "fail"`
  - `issues: [{ severity, file, description, expected, actual, edgeRef? }]`
- Reviews run in parallel with a concurrency cap.
- Unmapped nodes are automatically flagged as failures.

### Phase 5: Per-Node Fix Loop

- Uses a surgical search/replace LLM schema (`nodeFixSchema`).
- Each failing node gets up to 5 fix attempts.
- After each fix, only that node is re-reviewed.
- Updates `results.fixerHistory` with files modified.

### Phase 6: Build Check (Always Runs)

- Runs `tsc --noEmit` again.
- On failures, runs the build fixer up to 3 times.
- If the build fixer modified any files, the loop returns to Phase 4 so all
  nodes are re-reviewed for cross-node semantic regressions.
- If the build passed cleanly (no file changes), the loop exits to Final Gate.

## Final Gate: `vite build`

- Runs `npx vite build`.
- If this fails, the final verdict is forced to `fail`.

## Review Results Output

`review_results.json` is written to the output directory and contains:

- `iterations`: total fixer passes run.
- `finalVerdict`: `"pass"` or `"fail"`.
- `nodeReviews`: final review state for every node.
- `buildErrorHistory`: all build errors with iteration/source tags.
- `fixerHistory`: which files were modified by each fix pass.
- `finalBuildErrors`: vite build errors (if any).

## Notes on Requesting behavior

Long-running build requests are handled by the Requesting framework. The request
response waits for `Requesting.respond` instead of timing out, which allows
frontend generation (often 15–30 minutes) to finish without the initial request
expiring.
