import dspy
import json
import os
import sys
import tempfile
import contextvars
import concurrent.futures
import subprocess
import threading
from contextlib import nullcontext
from typing import Any, Dict, List

DEFAULT_NON_AI_REQUESTING_TIMEOUT_MS = int(os.getenv("REQUESTING_TIMEOUT", "10000"))
DEFAULT_AI_REQUESTING_TIMEOUT_MS = int(
    os.getenv("GENERATED_AI_CALL_TIMEOUT_MS", "45000")
)
DEFAULT_NON_AI_SYNC_TEST_TIMEOUT_MS = int(
    os.getenv("GENERATED_SYNC_TEST_TIMEOUT_MS", "30000")
)
DEFAULT_AI_TOUCHING_SYNC_TEST_TIMEOUT_MS = int(
    os.getenv("GENERATED_SYNC_TEST_AI_TOUCHING_TIMEOUT_MS", "120000")
)


def build_generated_ai_test_env(extra_env: Dict[str, str] | None = None) -> Dict[str, str]:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    gemini_key = env.get("GEMINI_API_KEY") or env.get("GOOGLE_GENERATIVE_AI_API_KEY") or ""
    generated_provider = env.get("GENERATED_TEST_AI_PROVIDER") or env.get("AI_PROVIDER") or ""
    generated_model = env.get("GENERATED_TEST_AI_MODEL") or env.get("AI_MODEL") or env.get("GEMINI_MODEL") or ""

    if generated_provider:
        env["AI_PROVIDER"] = generated_provider
    if generated_model:
        env["AI_MODEL"] = generated_model
        env["GEMINI_MODEL"] = generated_model

    if gemini_key:
        env["GEMINI_API_KEY"] = gemini_key
        env["GOOGLE_GENERATIVE_AI_API_KEY"] = gemini_key

    return env


def parse_ai_touching_flag(raw_value: Any) -> bool | None:
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, str):
        normalized = raw_value.strip().lower()
        if normalized in {"true", "yes", "1"}:
            return True
        if normalized in {"false", "no", "0"}:
            return False
    return None


def resolve_validation_timeouts(ai_touching: bool) -> tuple[int, int]:
    if ai_touching:
        return (
            max(DEFAULT_NON_AI_REQUESTING_TIMEOUT_MS, DEFAULT_AI_REQUESTING_TIMEOUT_MS),
            max(DEFAULT_NON_AI_SYNC_TEST_TIMEOUT_MS, DEFAULT_AI_TOUCHING_SYNC_TEST_TIMEOUT_MS),
        )
    return (DEFAULT_NON_AI_REQUESTING_TIMEOUT_MS, DEFAULT_NON_AI_SYNC_TEST_TIMEOUT_MS)

# --- Signatures ---

class SelectRelevantConcepts(dspy.Signature):
    """Determine which concepts are relevant for implementing the syncs for a specific endpoint.
    
    CRITICAL: You MUST select at least ONE concept for every endpoint. Every API endpoint requires concepts to implement its logic. Do NOT return an empty list or null.
    
    IMPORTANT: If 'Authenticating' is relevant, 'Sessioning' is almost ALWAYS relevant for session management (creating tokens on login/register).
    Always include 'Sessioning' if 'Authenticating' is selected.

    CRITICAL: You MUST ONLY select concepts from the `available_concepts` list. Do NOT invent new concepts or select concepts that are not in this list.
    """
    
    endpoint_info: str = dspy.InputField()
    plan: str = dspy.InputField()
    concept_specs: str = dspy.InputField()
    available_concepts: List[str] = dspy.InputField(desc="List of available concept names. ONLY select from this list.")
    
    thought: str = dspy.OutputField()
    relevant_concepts: List[str] = dspy.OutputField(desc="REQUIRED: List of concept names whose implementations are needed. Must contain at least one concept from available_concepts. Never return empty or null.")
    ai_touching: bool = dspy.OutputField(desc="REQUIRED: True if this endpoint touches AI-backed concepts or requires AI-aware validation budget; otherwise false.")

class GenerateSyncsAndTests(dspy.Signature):
    """Generate sync definitions and tests for a specific API endpoint.
    
    The syncs should wire the Requesting concept to other concepts to fulfill the endpoint's logic.
    The tests should verify the endpoint behaves as expected, checking concept state changes.
    
    CRITICAL RULES TO FOLLOW:
    
    0. ALWAYS INCLUDE METHOD: Every Requesting.request pattern MUST include the HTTP method.
       BAD: { path: "/auth/logout" }
       GOOD: { path: "/auth/logout", method: "POST" }
    
    1. PATTERN MATCHING IS STRICT: Only include fields in `when` that are GUARANTEED to be in every request.
       Optional fields should be handled in `where` using frames.map, NOT in `when`.
       
    2. ONLY QUERIES IN `where`: Never call actions (side-effect methods) in `where` clauses.
       Only use query methods (prefixed with _). Actions go in `then` only.
       
    3. MULTI-SYNC PATTERN FOR MUTATIONS (POST/PUT/DELETE):
       - Request Sync: Match request -> trigger action in `then`
       - Success Sync: Match request + action success -> respond
       - Error Sync: Match request + action error -> respond with error
       
    4. SELF-CONTAINED PATTERN FOR READS (GET):
       Handle everything in one sync: when -> where (auth+query) -> then (respond)
       
    5. TESTS MUST COVER MISSING OPTIONAL FIELDS:
       Always test with requests that omit optional fields to catch pattern matching bugs.

    6. KEEP FIXES IN SCOPE:
       Only generate/modify endpoint syncs and endpoint tests. Never require concept changes.

    7. REQUEST INPUT CONTRACT:
       If request-derived values are optional (headers/query/body), bind them in `where` via Requesting input query.
       Do not rely on optional request fields in `when`.

    8. QUERY/MAP CONTRACT:
       Use `await frames.query(Concept._query, ...)` for async retrieval.
       Do not use async `frames.map(...)`, Promise.all over frames, or closures in query method references.

    9. TYPE BOUNDARY CONTRACT:
       Use concept-native types for concept query/action inputs.
       Normalize API response types at mapping/response boundary (e.g., String/Number/new Date(...).toISOString()).

    10. AI ENDPOINT CONTRACT:
       If the endpoint touches AI-backed concepts, keep prompts/documents intentionally
       small for speed, and assert structure/status/parseability rather than exact
       natural-language wording.
    """
    
    endpoint_info: str = dspy.InputField(desc="JSON string with method, path, summary, description.")
    plan: str = dspy.InputField(desc="Overall project plan.")
    concept_specs: str = dspy.InputField(desc="Specs of all available concepts.")
    relevant_implementations: str = dspy.InputField(desc="Code of relevant concepts.")
    openapi_spec: str = dspy.InputField(desc="The full OpenAPI specification. Use this to verify response schemas.")
    guidelines: str = dspy.InputField(desc="Patterns for syncs and testing. READ THESE CAREFULLY.")
    
    syncs_code: str = dspy.OutputField(desc="TypeScript code exporting individual `export const Name: Sync = ...` definitions. NO default export. Follow MULTI-SYNC pattern for mutations, SELF-CONTAINED pattern for reads.")
    test_code: str = dspy.OutputField(desc="Deno test file content. MUST include tests for requests with missing optional fields.")

class ReviewSyncsAgainstOpenAPI(dspy.Signature):
    """Review generated syncs/tests for correctness. You are the last gate before code ships.
    
    Return PASS only if ALL of the following hold:

    ## Scope Constraints (Hard Limits)
    0) Reviewer scope is STRICTLY `syncs.ts` and endpoint test files only.
       - NEVER instruct changing concept implementations/classes/specs.
       - NEVER request adding new concept methods.
       - If required method is missing, require sync-level restructuring using existing methods
         (for example: per-item loops in `where` when no batch query exists).
       - Keep guidance general and reusable; avoid endpoint-specific rewrites unless strictly required.
       - Prefer smallest root-cause fix set first; avoid broad rewrites when one constraint violation explains multiple failures.
    
    ## OpenAPI Compliance
    1) Response shapes and required fields match the OpenAPI spec exactly.
    2) Every string literal in sync logic (role checks, status comparisons, type guards)
       exactly matches the corresponding OpenAPI enum values — including casing.
    
    ## Sync Structure
    3) Sync field reads/writes are consistent with concept method contracts.
    4) ONLY query methods (prefixed with `_`) are called in `where` clauses. Actions go in `then` only.
    5) Every success/error sync's `when` clause includes `Requesting.request` with the specific path AND method,
       so it only fires for its own endpoint — not globally for any use of that action.
    6) All variables needed in `then` are bound in `when` or queried in `where`.
       `Requesting.respond` needs `{ request }` passed through from `when`.
    7) `actions(...)` uses comma-separated tuples: `actions([A, {}], [B, {}])`.
       FAIL if you see nested arrays: `actions([[A, {}], [B, {}]])`.
    8) `frames.query(...)` takes a direct method reference: `frames.query(Concept._method, ...)`.
       FAIL if wrapped in an arrow function: `frames.query(async () => ...)`.
    9) Optional request-derived fields (headers/query/body) are NOT in `when` patterns.
       They should be handled in `where` after querying request input.
    10) ONLY methods from `relevant_implementations` are referenced.
        FAIL if `declare module` is used to invent methods — crashes at runtime.
    
    ## Type Safety
    11) Values from MongoDB or API input are type-normalized before type-specific methods
        (e.g. `new Date()` before `.toISOString()`, `String()` for IDs, `Number()` for numbers).
    12) MongoDB/ObjectId-like values are stringified when constructing API response payloads.
    
    ## Test Quality
    13) Tests would fail for incorrect field mappings (tests do not mirror the same bug as syncs).
    14) Tests cover missing optional fields, not just the happy path.
    15) Tests validate response structure against OpenAPI (required fields, types, wrappers).
    16) Tests use `Logging.OFF` (not `Logging.SILENT`), `sanitizeOps: false`, `sanitizeResources: false`.
    17) Tests call `request()` first, then `_awaitResponse()` — never the reverse.
    18) Tests do NOT instantiate concepts (`new concepts.X(db)`) — use pre-exported instances.

    ## Runtime Safety and Media URL Correctness
    19) Async query usage must be valid for this runtime:
        - FAIL if code calls `.then(...)` on the result of `frames.query(...)` (e.g. `frames.query(...).then(...)`).
        - Require `await frames.query(...)` and subsequent synchronous mapping/filtering on the returned Frames object.
        - FAIL if code uses async `frames.map(...)`, Promise.all over frames, or closure/function values inside query input records.
        - This specifically prevents PATCH flows (such as `/me/profile`) from crashing before persistence.
    20) Media URLs returned by API responses must be frontend-loadable:
        - For media assets, return canonical paths with `/media/...` (NOT `/api/media/...`).
        - If `PUBLIC_API_URL` is present, prefer fully-qualified URLs like
          `${PUBLIC_API_URL}/media/...` (normalized to avoid double slashes).
        - Reviewer must FAIL if generated sync logic/tests allow returning media URLs that would resolve
          against frontend origin and 404.

    ## File Hosting and Streaming Contracts
    21) File upload endpoints MUST use multipart contracts for binary fields.
        - FAIL if upload flow expects JSON base64 payloads for file bytes.
        - Require request handling that accepts multipart file bytes and preserves file MIME and name.
        - Upload success responses must include `url`, `mimeType`, `size`, and `fileName`.
    22) `GET /media/{id}` serving paths must return stream-safe file metadata and headers.
        - Require `Content-Type`, `Content-Disposition`, and `Accept-Ranges: bytes`.
        - For ranged requests, require `206 Partial Content` + valid `Content-Range`.
        - FAIL if implementation ignores range semantics for media/video/file playback.
    23) Range passthrough contract must be preserved end-to-end.
        - If Requesting input includes `range`, sync must pass it into media retrieval query (e.g. `_getMediaData({ mediaId, range })`).
        - FAIL if serving sync drops/ignores range header input.

    ## No Concept Expansion
    24) NEVER suggest changing selected concepts or adding concepts during review.
        - Keep feedback limited to edits in generated syncs/tests.
    
    If anything deviates, return FAIL with precise, actionable issues including which rule was violated.
    Format FAIL issues as a numbered checklist optimized for handoff to the fixer:
      - root cause first
      - exact sync/test symbol(s) to edit
      - minimal patch direction
      - avoid broad rewrites
    When test failures are provided in endpoint_info, diagnose the root cause and suggest specific fixes.
    """
    
    endpoint_info: str = dspy.InputField(desc="JSON string with method, path, summary, description. May include test failure output to diagnose.")
    openapi_spec: str = dspy.InputField(desc="The full OpenAPI specification.")
    syncs_code: str = dspy.InputField(desc="Generated syncs code for the endpoint.")
    test_code: str = dspy.InputField(desc="Generated tests for the endpoint.")
    relevant_concepts: List[str] = dspy.InputField(desc="Concept names selected for this endpoint.")
    available_concepts: List[str] = dspy.InputField(desc="All concept names available to this endpoint. Any additions MUST come from this list.")
    concept_specs: str = dspy.InputField(desc="Full concept specs for all available concepts.")
    selected_concept_specs: str = dspy.InputField(desc="Specs for currently selected relevant concepts.")
    relevant_implementations: str = dspy.InputField(desc="Code of relevant selected concepts. Use as field/method source of truth.")
    guidelines: str = dspy.InputField(desc="Sync DSL reference, engine source files, and generation rules. Use to verify patterns, APIs, and common error causes.")
    
    verdict: str = dspy.OutputField(desc="PASS or FAIL")
    issues: str = dspy.OutputField(desc="Specific, actionable checklist for fixer if FAIL — include rule number, root cause, exact symbol(s)/section(s) to edit, and minimal patch direction. When diagnosing test failures, identify root cause in syncs or tests. Otherwise 'none'.")
    add_relevant_concepts: List[str] = dspy.OutputField(desc="ALWAYS return []. Concept expansion is disabled; reviewer must not request concept-list changes.")

class AgentStep(dspy.Signature):
    """Analyze errors and propose a tool action to fix syncs or tests.

    PRIORITY: REVIEWER FEEDBACK IS THE SOURCE OF TRUTH.
    If error_log contains "Review Failed", fix ONLY what the reviewer listed — nothing else.
    Do NOT refactor, restructure, or "improve" unrelated code. Surgical, minimal changes only.
    The reviewer has full context (OpenAPI spec, engine source, concept implementations, guidelines).
    Trust its diagnosis and apply the exact fixes it describes.

    HARD CONSTRAINTS:
    - You can ONLY edit generated syncs/tests. NEVER propose editing concept implementations.
    - If reviewer feedback asks for missing concept methods or concept changes, reinterpret it into
      sync-only fixes using existing methods (e.g. iterate per id in `where` when batch query is unavailable).
    - Always return a valid action envelope: non-empty `tool_name` and JSON `tool_args`.
    - If uncertain, return `tool_name="run_tests"` with `tool_args="{}"` instead of partial/invalid actions.
    - Keep reasoning concise and surgical (no long rewrites).
    - If reviewer feedback contains multiple issues, fix highest-leverage root causes first (matching/runtime/contract),
      then follow with schema/assertion cleanup.
    """
    
    endpoint: str = dspy.InputField()
    file_contents: str = dspy.InputField(desc="Current syncs.ts and test.ts contents.") 
    error_log: str = dspy.InputField(desc="Test failures and/or reviewer feedback. The REVIEWER IS THE SOURCE OF TRUTH. If reviewer issues are present, fix EXACTLY what the reviewer says — nothing more, nothing less. Do not touch code the reviewer did not flag.")
    previous_actions: str = dspy.InputField(desc="History of fixes.")
    relevant_implementations: str = dspy.InputField(desc="Code of relevant concepts already in context.")
    guidelines: str = dspy.InputField(desc="Patterns for syncs and testing. Contains CRITICAL RULES.")
    
    thought: str = dspy.OutputField(desc="Short reasoning about the fix. If reviewer feedback is present, quote the specific issue being addressed. Do not address unrelated issues.")
    tool_name: str = dspy.OutputField(desc="replace, delete, insert_after, overwrite, read_concept, run_tests")
    tool_args: str = dspy.OutputField(desc="JSON string of arguments. replace: {'target': 'syncs'|'tests', 'old_code': '...', 'new_code': '...'}, delete: {'target': 'syncs'|'tests', 'code_to_delete': '...'}, insert_after: {'target': 'syncs'|'tests', 'after_code': '...', 'new_code': '...'}, overwrite: {'target': 'syncs'|'tests', 'new_code': '...'} or {'syncs': '...', 'tests': '...'}, read_concept: {'concepts': ['ConceptName1', 'ConceptName2']}, run_tests: {}. CRITICAL: target MUST be 'syncs' or 'tests' only. NEVER use 'database' or 'impl'.")

# --- Helper Classes ---

def _normalize_for_match(s: str) -> str:
    """Normalize string for matching - handles CRLF/LF differences across platforms."""
    if not s:
        return s
    return s.replace("\r\n", "\n").replace("\r", "\n").strip()


class CodeEditor:
    def __init__(self, sync_code: str, test_code: str):
        self.sync_code = sync_code
        self.test_code = test_code

    def _validate_target(self, target: str) -> str | None:
        """Returns error message if target is invalid, else None."""
        if target in ("syncs", "tests"):
            return None
        if target in ("database", "impl", "implementation"):
            return f"Error: target must be 'syncs' or 'tests' only. You used '{target}'. Fix syncs with target:'syncs', fix tests with target:'tests'."
        return f"Error: Unknown target: {target}. Valid targets are 'syncs' and 'tests' only."

    def get_code(self, target: str) -> str:
        if target == "syncs": return self.sync_code
        if target == "tests": return self.test_code
        raise ValueError(f"Unknown target: {target}")

    def set_code(self, target: str, new_code: str):
        if target == "syncs": self.sync_code = new_code
        elif target == "tests": self.test_code = new_code
        else: raise ValueError(f"Unknown target: {target}")

    def replace(self, target: str, old_code: str, new_code: str) -> str:
        try:
            err = self._validate_target(target)
            if err:
                return err
            current = self.get_code(target)
            # Normalize for cross-platform (CRLF vs LF) - Docker uses LF, Windows may use CRLF
            old_norm = _normalize_for_match(old_code) if old_code else ""
            normalized_current = current.replace("\r\n", "\n").replace("\r", "\n")
            if not old_norm:
                return "Error: old_code cannot be empty."
            if old_norm not in normalized_current:
                return f"Error: old_code not found in {target}. Use exact string from file or use overwrite."
            if normalized_current.count(old_norm) > 1:
                return f"Error: old_code found {normalized_current.count(old_norm)} times. Provide unique context."
            result = normalized_current.replace(old_norm, new_code, 1)
            self.set_code(target, result)
            return "Success: Code replaced."
        except Exception as e:
            return f"Error: {str(e)}"

    def delete(self, target: str, code_to_delete: str) -> str:
        try:
            err = self._validate_target(target)
            if err:
                return err
            current = self.get_code(target)
            norm_del = _normalize_for_match(code_to_delete) if code_to_delete else ""
            norm_cur = current.replace("\r\n", "\n").replace("\r", "\n")
            if not norm_del or norm_del not in norm_cur:
                return f"Error: code_to_delete not found in {target}."
            self.set_code(target, norm_cur.replace(norm_del, "", 1))
            return "Success: Code deleted."
        except Exception as e:
            return f"Error: {str(e)}"

    def insert_after(self, target: str, after_code: str, new_code: str) -> str:
        try:
            err = self._validate_target(target)
            if err:
                return err
            current = self.get_code(target)
            norm_after = _normalize_for_match(after_code) if after_code else ""
            norm_cur = current.replace("\r\n", "\n").replace("\r", "\n")
            if not norm_after or norm_after not in norm_cur:
                return f"Error: after_code not found in {target}."
            self.set_code(target, norm_cur.replace(norm_after, norm_after + "\n" + new_code, 1))
            return "Success: Code inserted."
        except Exception as e:
            return f"Error: {str(e)}"

    def overwrite(self, target: str, new_code: str) -> str:
        try:
            err = self._validate_target(target)
            if err:
                return err
            self.set_code(target, new_code)
            return "Success: File overwritten."
        except Exception as e:
            return f"Error: {str(e)}"

# --- Main Generator ---

class SyncGenerator(dspy.Module):
    def __init__(self, flash_lm=None):
        super().__init__()
        self.concept_selector = dspy.ChainOfThought(SelectRelevantConcepts)
        self.generator = dspy.ChainOfThought(GenerateSyncsAndTests)
        self.agent_step = dspy.ChainOfThought(AgentStep)
        self.reviewer = dspy.ChainOfThought(ReviewSyncsAgainstOpenAPI)
        self.flash_lm = flash_lm
        
        # Shared lock to serialize CPU-heavy validation steps
        self.validation_lock = threading.Lock()

    def _build_relevant_implementations(
        self,
        relevant_concepts: List[str],
        implementations: Dict[str, Dict[str, str]],
    ) -> str:
        relevant_implementations_str = ""
        for concept in relevant_concepts:
            if concept == "Requesting":
                continue  # Requesting is built-in and always available
            if concept in implementations:
                code = implementations[concept].get("code", "")
                relevant_implementations_str += f"--- CONCEPT: {concept} ---\n{code}\n\n"
            else:
                print(f"Warning: Selected concept '{concept}' not found in implementations.", file=sys.stderr)
        return relevant_implementations_str

    def _extract_selected_concept_specs(self, concept_specs: str, selected_concepts: List[str]) -> str:
        if not concept_specs or not selected_concepts:
            return ""
        try:
            import re

            selected_blocks: List[str] = []
            seen = set()
            for concept in selected_concepts:
                if concept in seen:
                    continue
                seen.add(concept)

                # Match markdown concept blocks such as: **concept** Profiling [User]
                pattern = (
                    r"(?is)(^\s*\*\*concept\*\*\s+"
                    + re.escape(concept)
                    + r"\b.*?)(?=^\s*\*\*concept\*\*\s+\w|\Z)"
                )
                match = re.search(pattern, concept_specs, flags=re.MULTILINE)
                if match:
                    selected_blocks.append(match.group(1).strip())
                    continue

                # Fallback: capture an @concept doc block in TS comments.
                pattern_ts = (
                    r"(?is)(^\s*/\*\*.*?@concept\s+"
                    + re.escape(concept)
                    + r"\b.*?\*/)"
                )
                match_ts = re.search(pattern_ts, concept_specs, flags=re.MULTILINE)
                if match_ts:
                    selected_blocks.append(match_ts.group(1).strip())

            return "\n\n".join(selected_blocks)
        except Exception:
            return ""

    def _normalize_reviewer_added_concepts(
        self,
        raw_added: Any,
        available_concepts: List[str],
        current_relevant_concepts: List[str],
    ) -> List[str]:
        candidates: List[str] = []
        if raw_added is None:
            return []

        if isinstance(raw_added, list):
            candidates = [str(c).strip() for c in raw_added if str(c).strip()]
        elif isinstance(raw_added, str):
            text = raw_added.strip()
            if not text:
                candidates = []
            else:
                try:
                    parsed = json.loads(text)
                    if isinstance(parsed, list):
                        candidates = [str(c).strip() for c in parsed if str(c).strip()]
                    else:
                        candidates = [p.strip() for p in text.split(",") if p.strip()]
                except Exception:
                    candidates = [p.strip() for p in text.split(",") if p.strip()]

        allowed = set(available_concepts)
        existing = set(current_relevant_concepts)
        additions: List[str] = []
        for concept in candidates:
            if concept == "Requesting":
                continue
            if concept in allowed and concept not in existing and concept not in additions:
                additions.append(concept)
        return additions

    # Remove markdown code block fences if present
    def _clean_code(self, code: str) -> str:
        if not code: return ""
        code = code.strip()
        
        # Remove markdown fences
        if code.startswith("```typescript"):
            code = code[13:]
        elif code.startswith("```ts"):
            code = code[5:]
        elif code.startswith("```"):
            code = code[3:]
        
        if code.endswith("```"):
            code = code[:-3]
            
        code = code.strip()

        # HARD FIX: Autocorrect the persistent hallucination of importing Engine from @engine
        # The agent loves to write `import { Engine, Logging } from "@engine"` or `import { Engine } from "@engine"`
        # We enforce: `import { Engine } from "@concepts"` and `import { Logging } from "@engine"`
        
        # 1. Handle combined import: import { Engine, Logging } from "@engine"
        if 'import { Engine, Logging } from "@engine"' in code:
            code = code.replace(
                'import { Engine, Logging } from "@engine"', 
                'import { Engine } from "@concepts";\nimport { Logging } from "@engine"'
            )
        if 'import { Logging, Engine } from "@engine"' in code:
             code = code.replace(
                'import { Logging, Engine } from "@engine"', 
                'import { Engine } from "@concepts";\nimport { Logging } from "@engine"'
            )
            
        # 2. Handle single import: import { Engine } from "@engine"
        # We use regex to be safe about spacing
        import re
        code = re.sub(r'import\s+\{\s*Engine\s*\}\s+from\s+["\']@engine["\'];?', 'import { Engine } from "@concepts";', code)
        
        # 3. HARD FIX: Autocorrect actions([[A, B], [C, D]]) -> actions([A, B], [C, D])
        # The LLM sometimes wraps tuples in an extra array, causing TS2740 under Deno 2.6+.
        code = re.sub(r'actions\(\[\s*(\[[^\]]*\])(\s*,\s*\[[^\]]*\])*\s*\]\)', lambda m: 'actions(' + m.group(0)[len('actions(['):-len('])')] + ')', code)
        
        # Heuristic: If code starts with spec-like text (e.g. "**concept**", "# Concept"), 
        # try to find the start of the actual code (imports or class).
        # This handles cases where the model includes the spec before the code.
        lines = code.split("\n")
        start_idx = 0
        for i, line in enumerate(lines):
            line_stripped = line.strip()
            # Check for common TS start patterns
            if (line_stripped.startswith("import ") or 
                line_stripped.startswith("export ") or 
                line_stripped.startswith("class ") or 
                line_stripped.startswith("interface ") or
                line_stripped.startswith("type ") or
                line_stripped.startswith("const ") or
                line_stripped.startswith("let ") or
                line_stripped.startswith("function ")):
                start_idx = i
                break
        
        if start_idx > 0:
            code = "\n".join(lines[start_idx:])
                
        return code.strip()


    def _setup_temp_env(self, temp_dir: str, implementations: Dict[str, Dict[str, str]]):
        # Paths
        current_dir = os.path.dirname(os.path.abspath(__file__))
        repo_root = os.path.abspath(os.path.join(current_dir, "../../../../"))
        
        # 1. Create Structure
        src_dir = os.path.join(temp_dir, "src")
        concepts_dir = os.path.join(src_dir, "concepts")
        syncs_dir = os.path.join(src_dir, "syncs")
        tests_dir = os.path.join(src_dir, "tests")
        # engine/utils will be copied
        
        os.makedirs(concepts_dir, exist_ok=True)
        os.makedirs(syncs_dir, exist_ok=True)
        os.makedirs(tests_dir, exist_ok=True)
        
        # 2. Copy Engine and Utils
        import shutil
        shutil.copytree(os.path.join(repo_root, "src/engine"), os.path.join(src_dir, "engine"))
        shutil.copytree(os.path.join(repo_root, "src/utils"), os.path.join(src_dir, "utils"))
        
        # 3. Write Concepts
        concept_imports = []
        concept_exports = []
        
        # Explicitly add Requesting concept (it's always needed)
        try:
            req_path = os.path.join(concepts_dir, "Requesting")
            os.makedirs(req_path, exist_ok=True)
            requesting_src = os.path.join(repo_root, "src/concepts/Requesting/RequestingConcept.ts")
            
            if os.path.exists(requesting_src):
                with open(requesting_src, "r", encoding="utf-8") as f:
                    req_code = f.read()
                with open(os.path.join(req_path, "RequestingConcept.ts"), "w", encoding="utf-8") as f:
                    f.write(req_code)
                
                concept_imports.append('import RequestingConcept from "./Requesting/RequestingConcept.ts";')
                concept_exports.append('export const Requesting = Engine.instrumentConcept(new RequestingConcept(db));')
            
        except Exception as e:
            print(f"Warning: Failed to setup Requesting concept: {e}", file=sys.stderr)

        for name, impl in implementations.items():
            concept_path = os.path.join(concepts_dir, name)
            os.makedirs(concept_path, exist_ok=True)
            
            code = impl.get("code", "")
            real_filename = f"{name}Concept.ts"
            
            with open(os.path.join(concept_path, real_filename), "w", encoding="utf-8") as f:
                f.write(code)
                
            # Assume default export of class named {Name}Concept
            # We import it as {Name}Concept from file
            concept_imports.append(f'import {name}Concept from "./{name}/{real_filename}";')
            concept_exports.append(f'export const {name} = Engine.instrumentConcept(new {name}Concept(db));')
            
        # Write src/concepts/index.ts is NO LONGER NEEDED manually 
        # because generate_imports.ts will generate concepts.ts and test_concepts.ts
        # BUT we need to make sure our test uses one of those.
        # The standard pattern is `import * as concepts from "@concepts"` where @concepts -> ./src/concepts/index.ts
        # In our real repo, @concepts maps to src/concepts/index.ts (which exports from concepts.ts).
        # We need to replicate that structure or update deno.json.
        
        # Let's write a simple index.ts that re-exports from the file generate_imports.ts creates.
        # generate_imports.ts creates 'concepts.ts' (production) and 'test_concepts.ts' (test DB).
        # We want our validation environment to use the test DB version.
        
        index_content = """
// Re-export from the auto-generated test concepts file
export * from "./test_concepts.ts";
export { freshID } from "@utils/database.ts"; // Explicit export for tests
"""
        with open(os.path.join(concepts_dir, "index.ts"), "w", encoding="utf-8") as f:
            f.write(index_content)

        # 4. Create deno.json
        # Ensure we use file:/// URI format for Deno imports on Windows to avoid "Unsupported scheme 'c'" errors
        # pathlib.Path.as_uri() handles this correctly across platforms
        from pathlib import Path
        real_utils_path = os.path.join(repo_root, "src/utils")
        real_utils_uri = Path(real_utils_path).as_uri()
        if not real_utils_uri.endswith("/"):
            real_utils_uri += "/"

        repo_deno_json_path = os.path.join(repo_root, "deno.json")
        repo_imports: Dict[str, str] = {}
        if os.path.exists(repo_deno_json_path):
            try:
                with open(repo_deno_json_path, "r", encoding="utf-8") as f:
                    repo_deno_json = json.load(f)
                repo_imports = dict(repo_deno_json.get("imports", {}))
            except Exception:
                repo_imports = {}

        imports = {
            **repo_imports,
            "@concepts": "./src/concepts/index.ts",
            "@engine": "./src/engine/mod.ts",
            "@syncs": "./src/syncs/syncs.ts",
            "@utils/": real_utils_uri,
        }

        deno_json = { "imports": imports }
        with open(os.path.join(temp_dir, "deno.json"), "w") as f:
            f.write(json.dumps(deno_json, indent=2))

        # Keep dependency resolution deterministic in temp validation env.
        # Without a lockfile here, Deno may resolve newer @std versions than the main app.
        repo_lock = os.path.join(repo_root, "deno.lock")
        if os.path.exists(repo_lock):
            shutil.copy2(repo_lock, os.path.join(temp_dir, "deno.lock"))
            
    def generate_syncs(self, endpoint: Dict[str, Any], plan: Dict[str, Any], concept_specs: str, implementations: Dict[str, Dict[str, str]], openapi_spec: str = "", max_fix_iterations: int = 10) -> Dict[str, Any]:
        """
        Generates syncs and tests for an endpoint, with a fix loop.
        
        Args:
            max_fix_iterations: Maximum number of fix loop iterations (default 10).
        """
        # Load background context for sync DSL
        context_docs = ""
        try:
            current_dir = os.path.dirname(os.path.abspath(__file__))
            repo_root = os.path.abspath(os.path.join(current_dir, "../../../../"))
            
            # 1. Sync DSL Background
            bg_path = os.path.join(repo_root, "design/background/implementing-synchronizations.md")
            if os.path.exists(bg_path):
                with open(bg_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- DSL REFERENCE (implementing-synchronizations.md) ---\n{f.read()}\n\n"

            # 2. Engine Types (Ground Truth)
            types_path = os.path.join(repo_root, "src/engine/types.ts")
            if os.path.exists(types_path):
                with open(types_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- ENGINE TYPES (src/engine/types.ts) ---\n{f.read()}\n\n"
            
            # 3. Engine Core (Logging, actions, SyncConcept)
            sync_ts_path = os.path.join(repo_root, "src/engine/sync.ts")
            if os.path.exists(sync_ts_path):
                with open(sync_ts_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- ENGINE CORE (src/engine/sync.ts - exports for @engine) ---\n{f.read()}\n\n"

            # 4. Engine Frames
            frames_path = os.path.join(repo_root, "src/engine/frames.ts")
            if os.path.exists(frames_path):
                with open(frames_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- ENGINE FRAMES (src/engine/frames.ts) ---\n{f.read()}\n\n"

            # 5. Concepts Structure (Reference for @concepts exports)
            concepts_ts_path = os.path.join(repo_root, "src/concepts/concepts.ts")
            if os.path.exists(concepts_ts_path):
                with open(concepts_ts_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- CONCEPTS EXPORTS (src/concepts/concepts.ts - Reference for @concepts) ---\n{f.read()}\n\n"
            
            # 6. Generated Examples (Ground Truth for this project)
            examples_path = os.path.join(current_dir, "generated_examples.md")
            if os.path.exists(examples_path):
                with open(examples_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- GENERATED EXAMPLES (Reference these patterns!) ---\n{f.read()}\n\n"

            # 7. Database Utils (freshID, etc.)
            db_path = os.path.join(repo_root, "src/utils/database.ts")
            if os.path.exists(db_path):
                with open(db_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- DATABASE UTILS (src/utils/database.ts) ---\n{f.read()}\n\n"

            # 8. Requesting Concept (Infrastructure)
            req_path = os.path.join(repo_root, "src/concepts/Requesting/RequestingConcept.ts")
            if os.path.exists(req_path):
                with open(req_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- REQUESTING CONCEPT (src/concepts/Requesting/RequestingConcept.ts) ---\n{f.read()}\n\n"

        except Exception:
            pass

        rules = (
            "=== SYNC GENERATION RULES ===\n\n"
            
            "### RULE 0: ALWAYS Include `method` in Request Patterns ###\n"
            "Every `Requesting.request` pattern MUST include the HTTP method.\n"
            "  BAD: `{ path: \"/auth/logout\" }`\n"
            "  GOOD: `{ path: \"/auth/logout\", method: \"POST\" }`\n\n"
            
            "### RULE 1: Pattern Matching is STRICT on Undefined Fields ###\n"
            "If a field is in the `when` pattern but undefined/missing in the request, the pattern will NOT match.\n"
            "  BAD - if bioImageUrl is not in request, sync won't fire:\n"
            "    { path: \"/profiles\", method: \"POST\", username, name, bio, bioImageUrl }\n"
            "  GOOD - only include fields that are GUARANTEED to be present:\n"
            "    { path: \"/profiles\", method: \"POST\", username, name, bio }\n"
            "  Then handle optional fields in `where` clause using frames.map to extract them if present.\n\n"
            "  Generalization: Treat optional request-derived values (headers/query/body) as `where` bindings.\n\n"
            
            "### RULE 2: Only Use QUERIES in `where` Clauses ###\n"
            "NEVER call actions (side-effect methods) in `where` clauses. Only use query methods (prefixed with _).\n"
            "  GOOD - _getUser is a query:\n"
            "    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });\n"
            "  BAD - createProfile is an action with side effects:\n"
            "    frames = await frames.query(Profiling.createProfile, { ... }, { ok });\n"
            "Actions belong ONLY in the `then` clause.\n\n"
            
            "### RULE 3: Use MULTI-SYNC Pattern for Mutations (POST/PUT/DELETE) ###\n"
            "For create/update/delete operations, use SEPARATE syncs:\n"
            "  1. Request Sync: Match request -> trigger action in `then`\n"
            "  2. Success Sync: Match request + action success -> respond with success\n"
            "  3. Error Sync: Match request + action error -> respond with error\n"
            "  4. Auth Error Sync: Match request + auth failure -> respond 401\n"
            "CRITICAL: Success/error syncs MUST include `Requesting.request` with the specific `path` and `method` in their `when` clause. "
            "Matching only on the action (e.g. `Authenticating.register` success) without the originating request will cause the sync to fire for ALL endpoints that use that action, not just this one.\n\n"
            
            "### RULE 4: Use SELF-CONTAINED Pattern for Reads (GET) ###\n"
            "For read operations, handle everything in ONE sync:\n"
            "  - `when`: match the request\n"
            "  - `where`: authenticate + query data (using _ prefixed query methods)\n"
            "  - `then`: respond directly with the queried data\n"
            "No need for separate success/error syncs for reads.\n\n"
            
            "### RULE 6: Tests MUST Cover Missing Optional Fields ###\n"
            "ALWAYS test with requests that OMIT optional fields - don't just test the happy path with all fields present.\n"
            "This catches pattern matching bugs where syncs fail to fire due to missing optional fields.\n\n"
            
            "### RULE 7: STRICTLY Validate Response Schema against OpenAPI ###\n"
            "The generated test MUST verify that the response structure matches the OpenAPI definition EXACTLY.\n"
            "  - Check that all required fields are present.\n"
            "  - Check that field types are correct (string vs object).\n"
            "  - IF the OpenAPI says the response is `{ post: {...} }`, do NOT return just `{...}`.\n"
            "  - Use `assertExists` and `typeof` checks in the test to enforce this.\n\n"
            
            "=== ADDITIONAL GUIDELINES ===\n\n"
            "1. Use `SyncDefinition` interface.\n"
            "2. `when` clause matches `Requesting.request`.\n"
            "3. `then` clause triggers concept actions.\n"
            "4. NO passthrough routes allowed.\n"
            "5. In tests, use `Logging.OFF` instead of `Logging.SILENT`.\n"
            "6. In tests, use `concepts.freshID()` to create IDs, do NOT use `new concepts.ID()`.\n"
            "7. Export individual sync constants: `export const Name: Sync = ...`. Do NOT export a single `syncs` object.\n"
            "8. In tests, do NOT check for `statusCode` on success responses from `Requesting._awaitResponse()`. It is undefined by default (implicit 200).\n"
            "9. In tests, `Requesting._awaitResponse()` returns `[{ response: unknown }]`. You must access `.response` on the array item.\n"
            "10. In tests, ALWAYS use `sanitizeOps: false` and `sanitizeResources: false` in `Deno.test` options to prevent leak errors from MongoDB.\n"
            "11. In tests, ALWAYS ensure `client.close()` is called in a `finally` block.\n"
            "12. CRITICAL: In `when` clauses, `{ key: undefined }` does NOT match missing keys. To handle optional parameters:\n"
            "    - Preferred: Match only guaranteed keys in `when` and handle optional keys in `where` via map/filter.\n"
            "    - If splitting into multiple syncs, keep branching logic in `where` (not optional-key matching in `when`).\n"
            "13. IMPORTS in tests: Use the following import patterns explicitly:\n"
            "    ```typescript\n"
            "    import { assertEquals, assertExists } from \"jsr:@std/assert\";\n"
            "    import { testDb, freshID } from \"@utils/database.ts\";\n"
            "    import * as concepts from \"@concepts\";\n"
            "    import { Engine } from \"@concepts\";\n"
            "    import { Logging } from \"@engine\"; // Note: Engine is in @concepts, Logging is in @engine\n"
            "    import syncs from \"@syncs\";\n"
            "    import \"jsr:@std/dotenv/load\";\n"
            "    ```\n"
            "    Do NOT default import `Engine`.\n"
            "14. CRITICAL: In tests, DO NOT instantiate concepts (e.g., `new concepts.Authenticating(db)`). The `@concepts` module already exports instantiated concepts. Use them directly: `concepts.Authenticating`, `concepts.Sessioning`, etc.\n"
            "15. CRITICAL: In tests, do NOT import syncs from `@syncs/auth.sync.ts` or any specific file. ALWAYS import syncs using `import syncs from \"@syncs\";` as specified in Guideline 13. The `@syncs` alias points to the correct auto-generated syncs file for the test environment.\n"
            "16. CRITICAL: In `where` clauses, to return no matches (empty result), use `frames.filter(() => false)`. Do NOT use `new Frames([])` or `Frames.empty()` - these do not exist. The `where` clause should return a filtered version of `frames`, not construct new Frames objects.\n"
            "17. CRITICAL: Do NOT try to index frames with action functions like `$[Sessioning.delete]`. Frames are indexed by Symbols, not functions. To check if an action produced an error, use separate syncs for success/error cases with different `when` patterns, rather than checking action outputs in `where`.\n"
            "18. CRITICAL: In tests, correct usage of `Requesting`:\n"
            "    - CORRECT: `const { request } = await Requesting.request(inputs); const [response] = await Requesting._awaitResponse({ request });`\n"
            "    - INCORRECT (Argument): `await Requesting._awaitResponse(request)` -> Must be `{ request }` object.\n"
            "    - INCORRECT (Order): `const p = Requesting._awaitResponse(...); await Requesting.request(...)` -> `_awaitResponse` will throw because request doesn't exist yet.\n"
            "    - ALWAYS call `request()` first, then `_awaitResponse()`.\n"
            "19. CRITICAL: In syncs, ensure all variables needed for `then` actions are bound in `when` or `where`.\n"
            "    - If you need `user` in `then`, it MUST appear in `when` (e.g., `{ user }`) or be queried in `where`.\n"
            "    - `Requesting.respond` generally needs `{ request }` passed through from `when`.\n"
            "20. MongoDB `_id` fields are `ObjectId`, not strings. Stringify IDs when constructing API responses (e.g., `_id: String(doc._id)`). In tests, compare as strings.\n"
            "21. CRITICAL: ONLY reference methods that exist in `relevant_implementations`. NEVER use `declare module` to invent methods — it passes `deno check` but CRASHES at runtime. Restructure sync logic using methods that DO exist.\n"
            "21b. If a needed batch method does NOT exist in `relevant_implementations`, implement a sync-level fallback loop in `where` using available single-item query methods (e.g., iterate ids and aggregate results). Do NOT request concept changes or add concept methods.\n"
            "21c. NEVER bypass concept contracts by querying concept collections directly with raw `db.collection(...)` from syncs/tests.\n"
            "22. CRITICAL: String literals in sync logic (role checks, status comparisons, type filters) MUST exactly match the OpenAPI enum values and the values stored by concept methods — including casing. If the OpenAPI spec defines `enum: [Admin, Member]`, use `\"Admin\"` not `\"admin\"`. Cross-check every hardcoded string against the spec.\n"
            "23. Values from MongoDB or API input may not be the expected runtime type (e.g. dates as strings, ObjectIds as objects, numbers as strings). Never call type-specific methods (`.toISOString()`, `.toString()`, etc.) without normalizing first: `new Date(val)` for dates, `String(val)` for IDs, `Number(val)` for numbers.\n"
            "24. CRITICAL: `actions(...)` syntax requires comma-separated tuples, NOT an array of tuples. Write `actions([Action, {...}], [Action2, {...}])`, NOT `actions([[Action, {...}], [Action2, {...}]])`.\n"
            "25. CRITICAL: `frames.query(...)` requires the direct method reference (e.g. `Concept._method`), NEVER wrap it in an inline closure or arrow function. Write `await frames.query(Requesting._getInput, ...)` NOT `await frames.query(async (args) => ...)`.\n"
            "25b. CRITICAL: Query input records must be symbol/scalar bindings, not executable closures (e.g. `{ session: accessToken }`, never `{ session: (f) => ... }`).\n"
            "25c. CRITICAL: Do not perform async work inside `frames.map(...)` or via Promise.all over mapped frames; perform async work with `await frames.query(...)` only.\n"
            "25d. Request input shape from `Requesting._getInput` is the direct request input object. Access fields as `(f[input] as any).field`.\n"
            "25e. Type boundary: keep concept query/action inputs in concept-native types; normalize values when constructing API response payloads.\n"
            "26. FILE UPLOAD CONTRACT: Endpoints that upload files must use multipart ingestion (binary bytes + MIME + fileName metadata), not JSON base64 payload assumptions.\n"
            "27. MEDIA SERVING CONTRACT: `GET /media/{id}` responses must include proper serving metadata and headers (`Content-Type`, `Content-Disposition`, `Accept-Ranges`) and support ranged requests (`206` + `Content-Range`) when `range` is provided.\n"
            "28. RANGE PASSTHROUGH: If `Requesting` provides `range`, syncs must forward it to media retrieval query inputs so byte-range playback/download works end-to-end.\n"
            "29. AI-SPECIFIC TESTING: For AI-touching endpoint tests, keep prompts/documents/examples intentionally small so validation runs quickly, and assert status, response structure, parseability, and deterministic fields instead of brittle open-ended wording."
        )

        # Full guidelines (source files + rules) — used by initial generator and reviewer
        guidelines = f"{context_docs}{rules}"

        # Fixer guidelines are intentionally lightweight.
        # The fixer should execute reviewer issues, not re-interpret the full rulebook.
        fixer_guidelines = (
            "=== FIXER MODE ===\n"
            "- Reviewer issues are source of truth.\n"
            "- Edit only generated syncs/tests for this endpoint.\n"
            "- Apply minimal, surgical patches that satisfy reviewer checklist items.\n"
            "- Prioritize root-cause issues before schema/assertion cleanup.\n"
            "- If action args would be invalid/partial, return run_tests with {}.\n"
        )
        
        endpoint_str = json.dumps(endpoint)
        
        # 1. Select Relevant Concepts
        print(f"Selecting relevant concepts for {endpoint.get('method')} {endpoint.get('path')}...", file=sys.stderr)
        
        # Prepare available concepts list (Requesting is always available)
        available_concepts_list = list(implementations.keys())
        if "Requesting" not in available_concepts_list:
            available_concepts_list.append("Requesting")
        
        relevant_concepts = []
        ai_touching = None
        max_selector_retries = 3
        
        for attempt in range(max_selector_retries):
            selector_res = self.concept_selector(
                endpoint_info=endpoint_str,
                plan=json.dumps(plan),
                concept_specs=concept_specs,
                available_concepts=available_concepts_list
            )
            
            raw_concepts = selector_res.relevant_concepts
            
            # Check if we got a valid response
            if raw_concepts is None:
                print(f"Concept selector returned None (attempt {attempt + 1}/{max_selector_retries}). Retrying...", file=sys.stderr)
                continue
            
            # Validate that all selected concepts are in available list
            relevant_concepts = [c for c in raw_concepts if c in available_concepts_list]
            ai_touching = parse_ai_touching_flag(getattr(selector_res, "ai_touching", None))
            
            if not relevant_concepts:
                print(f"Concept selector returned empty or invalid list (attempt {attempt + 1}/{max_selector_retries}). Raw: {raw_concepts}. Retrying...", file=sys.stderr)
                continue
            if ai_touching is None:
                print(f"Concept selector did not return a valid ai_touching boolean (attempt {attempt + 1}/{max_selector_retries}). Retrying...", file=sys.stderr)
                continue
            
            # Success - we have valid concepts
            break
        else:
            # All retries exhausted
            print(f"WARNING: Concept selector failed after {max_selector_retries} attempts. Proceeding with no concepts.", file=sys.stderr)
            relevant_concepts = []
            ai_touching = False
        
        # Enforce heuristic: If Authenticating is present, Sessioning is likely needed
        if "Authenticating" in relevant_concepts and "Sessioning" not in relevant_concepts:
            if "Sessioning" in available_concepts_list:
                print("Auto-adding Sessioning concept because Authenticating is present.", file=sys.stderr)
                relevant_concepts.append("Sessioning")
             
        print(f"Selected concepts: {relevant_concepts} | ai_touching={ai_touching}", file=sys.stderr)
        
        relevant_implementations_str = self._build_relevant_implementations(relevant_concepts, implementations)
        
        # 2. Initial Generation
        # Prevent rate limits between steps
        # print("Sleeping 5s to avoid rate limits...", file=sys.stderr)
        # time.sleep(5)

        print(f"Calling LLM to generate syncs (Context size: {len(guidelines)} chars, Impl size: {len(relevant_implementations_str)} chars)...", file=sys.stderr)
        sys.stderr.flush()
        
        syncs_code = ""
        test_code = ""
        generation_error = None
        
        max_gen_retries = 3
        for attempt in range(max_gen_retries):
            try:
                # Copy the current thread's context (including any dspy.context LM override)
                # so the inner worker thread inherits it. Without this, Python < 3.12
                # ThreadPoolExecutor workers get a fresh context and lose the LM override.
                ctx = contextvars.copy_context()
                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(ctx.run, self.generator, 
                        endpoint_info=endpoint_str,
                        plan=json.dumps(plan),
                        concept_specs=concept_specs,
                        relevant_implementations=relevant_implementations_str,
                        openapi_spec=openapi_spec,
                        guidelines=guidelines
                    )
                    pred = future.result(timeout=240) # 4 minute timeout

                syncs_code = self._clean_code(pred.syncs_code)
                test_code = self._clean_code(pred.test_code)
                # Retry if output is truncated (empty or too short)
                if syncs_code.strip() and test_code.strip() and len(syncs_code) > 50:
                    break  # Success
                if attempt < max_gen_retries - 1:
                    print(f"LLM output truncated/empty (attempt {attempt + 1}/{max_gen_retries}), retrying...", file=sys.stderr)
            except concurrent.futures.TimeoutError:
                 print(f"LLM Call Timed Out (attempt {attempt+1}/{max_gen_retries})!", file=sys.stderr)
                 generation_error = "LLM Timeout"
            except Exception as e:
                 print(f"LLM Call Failed (attempt {attempt+1}/{max_gen_retries}): {e}", file=sys.stderr)
                 generation_error = str(e)
        else:
            # Failed after all retries
            return { "syncs": [], "testFile": "", "syncFile": "", "status": "error", "error": generation_error }
        
        # print(f"\n--- INITIAL GENERATED SYNC CODE ---\n{syncs_code}\n", file=sys.stderr)
        # print(f"\n--- INITIAL GENERATED TEST CODE ---\n{test_code}\n", file=sys.stderr)
        
        # Fix Loop — fixer gets source files only; reviewer (inside _full_validation) gets full guidelines
        return self._fix_loop(
            endpoint_str,
            syncs_code,
            test_code,
            implementations,
            relevant_implementations_str,
            relevant_concepts,
            fixer_guidelines,
            openapi_spec,
            concept_specs=concept_specs,
            guidelines=guidelines,
            max_iterations=max_fix_iterations,
            ai_touching=ai_touching,
        )

    def _full_validation(
        self,
        syncs_code: str,
        test_code: str,
        implementations: Dict[str, Dict[str, str]],
        endpoint_str: str,
        openapi_spec: str,
        relevant_concepts: List[str],
        relevant_implementations_str: str,
        concept_specs: str,
        guidelines: str = "",
        ai_touching: bool = False,
    ) -> tuple[bool, str | None, List[str], List[str], str]:
        """
        Runs deno validation (serialized), then review (parallel).
        Review always runs after deno test, even if tests fail — test errors
        are passed to the reviewer to help diagnose.
        A sync passes only when BOTH deno tests pass AND review passes.
        Returns:
          (success, combined_error, parsed_syncs, updated_relevant_concepts, updated_relevant_implementations).
        """
        # Phase 1: Deno validation (serialized via lock)
        deno_passed, check_error, test_error, json_syncs = self._run_deno_validation(
            syncs_code, test_code, implementations, endpoint_str, ai_touching=ai_touching
        )
        
        # If deno check itself failed (compilation error), no point reviewing
        if check_error:
            return (False, check_error, [], relevant_concepts, relevant_implementations_str)
        
        # Phase 2: Review (parallel — no lock) 
        # Always runs after deno test, regardless of test result.
        # Pass test_error to reviewer so it can help diagnose failures.
        review_passed, review_issues, reviewer_added_concepts = self._run_review(
            syncs_code, test_code, endpoint_str, openapi_spec,
            relevant_concepts=relevant_concepts,
            relevant_implementations=relevant_implementations_str,
            implementations=implementations,
            concept_specs=concept_specs,
            test_error=test_error,
            guidelines=guidelines
        )

        # Concept expansion from reviewer is intentionally disabled.
        updated_relevant_concepts = list(relevant_concepts)
        updated_relevant_implementations = self._build_relevant_implementations(
            updated_relevant_concepts,
            implementations,
        )
        
        # Both must pass. Put reviewer handoff first so fixer sees prioritized guidance.
        errors = []
        if not review_passed:
            errors.append(f"--- REVIEWER ISSUES (SOURCE OF TRUTH) ---\n{review_issues}")
        if test_error:
            errors.append(f"--- TEST/VALIDATION OUTPUT (SUPPORTING CONTEXT) ---\n{test_error}")
        
        if errors:
            return (
                False,
                "\n\n".join(errors),
                [],
                updated_relevant_concepts,
                updated_relevant_implementations,
            )
        
        return (
            True,
            None,
            json_syncs,
            updated_relevant_concepts,
            updated_relevant_implementations,
        )

    def _fix_loop(self, endpoint: str, syncs_code: str, test_code: str, implementations: Dict[str, Dict[str, str]], relevant_implementations_str: str, relevant_concepts: List[str], fixer_guidelines: str, openapi_spec: str, concept_specs: str, guidelines: str = "", max_iterations: int = 10, ai_touching: bool = False) -> Dict[str, Any]:
        reviewer_guidelines = guidelines or fixer_guidelines
        editor = CodeEditor(syncs_code, test_code)
        current_error = None
        history = []
        _, validation_timeout_ms = resolve_validation_timeouts(ai_touching)
        
        # Initial Check
        success, error, json_syncs, relevant_concepts, relevant_implementations_str = self._full_validation(
            editor.sync_code, editor.test_code, implementations, endpoint,
            openapi_spec, relevant_concepts, relevant_implementations_str,
            concept_specs=concept_specs,
            guidelines=reviewer_guidelines,
            ai_touching=ai_touching,
        )
        if success:
            return {
                "syncs": json_syncs,
                "testFile": editor.test_code,
                "syncFile": editor.sync_code,
                "status": "complete",
                "aiTouching": ai_touching,
                "validationTimeoutMs": validation_timeout_ms,
            }
        current_error = error

        for i in range(max_iterations):
            print(f"Sync Fix Loop {i+1}/{max_iterations} for {endpoint}", file=sys.stderr)
            
            files_context = f"--- SYNCS ---\n{editor.sync_code}\n\n--- TESTS ---\n{editor.test_code}"
            
            pred = None
            step_retries = 3
            step_error = None
            for attempt in range(step_retries):
                try:
                    pred = self.agent_step(
                        endpoint=endpoint,
                        file_contents=files_context,
                        error_log=current_error or "Run validation",
                        previous_actions="\n".join(history),
                        relevant_implementations=relevant_implementations_str,
                        guidelines=fixer_guidelines
                    )
                    break
                except Exception as e:
                    step_error = str(e)
                    print(f"Agent step error (attempt {attempt+1}/{step_retries}): {e}", file=sys.stderr)
                    import time
                    time.sleep(1)
            
            if pred is None:
                print(f"Agent step failed repeatedly. Aborting fix loop. Last error: {step_error}", file=sys.stderr)
                return {
                    "syncs": [], 
                    "testFile": editor.test_code,
                    "syncFile": editor.sync_code,
                    "status": "error",
                    "error_log": f"Agent step failed: {step_error}"
                }
            
            tool_name = pred.tool_name
            tool_args = {}
            try:
                tool_args = json.loads(pred.tool_args)
            except:
                pass
            
            print(f"  Agent thought: {pred.thought}", file=sys.stderr)

            result_msg = ""
            log_target = tool_args.get("target")
            if tool_name == "overwrite" and "syncs" in tool_args and "tests" in tool_args:
                log_target = "syncs+tests"
            elif log_target is None:
                log_target = "?"
            print(f"  Agent action: {tool_name} on {log_target}", file=sys.stderr)

            if tool_name == "replace":
                result_msg = editor.replace(tool_args.get("target"), tool_args.get("old_code"), tool_args.get("new_code"))
            elif tool_name == "delete":
                result_msg = editor.delete(tool_args.get("target"), tool_args.get("code_to_delete"))
            elif tool_name == "insert_after":
                result_msg = editor.insert_after(tool_args.get("target"), tool_args.get("after_code"), tool_args.get("new_code"))
            elif tool_name == "overwrite":
                if "syncs" in tool_args and "tests" in tool_args:
                    editor.set_code("syncs", tool_args["syncs"])
                    editor.set_code("tests", tool_args["tests"])
                    result_msg = "Success: Both files overwritten."
                else:
                    result_msg = editor.overwrite(tool_args.get("target"), tool_args.get("new_code"))
            elif tool_name == "run_tests":
                pass
            elif tool_name == "read_concept":
                concepts_to_read = tool_args.get("concepts") or []
                if isinstance(concepts_to_read, str):
                    concepts_to_read = [concepts_to_read]
                
                result_parts = []
                for concept in concepts_to_read:
                    if concept == "Requesting":
                        result_parts.append(f"Concept 'Requesting' is already in your context (see guidelines section '--- REQUESTING CONCEPT ---').")
                    elif f"--- CONCEPT: {concept} ---" in relevant_implementations_str:
                         result_parts.append(f"Concept '{concept}' is already in your context (see relevant_implementations).")
                    elif concept in implementations:
                        impl_code = implementations[concept].get("code", "")
                        result_parts.append(f"Read implementation for {concept}:\n{impl_code[:2000]}... (truncated)")
                    else:
                        result_parts.append(f"Error: Concept '{concept}' not found.")
                result_msg = "\n".join(result_parts)
            
            if result_msg and "Error" in result_msg:
                print(f"  Result: {result_msg[:120]}", file=sys.stderr)

            history.append(f"Thought: {pred.thought}\nAction: {tool_name} Args: {json.dumps(tool_args)}, Result: {result_msg}")
            
            # Re-validate: deno test (serialized) then review (parallel)
            success, error, json_syncs, relevant_concepts, relevant_implementations_str = self._full_validation(
                editor.sync_code, editor.test_code, implementations, endpoint,
                openapi_spec, relevant_concepts, relevant_implementations_str,
                concept_specs=concept_specs,
                guidelines=reviewer_guidelines,
                ai_touching=ai_touching,
            )
            if success:
                return {
                    "syncs": json_syncs,
                    "testFile": editor.test_code,
                    "syncFile": editor.sync_code,
                    "status": "complete",
                    "aiTouching": ai_touching,
                    "validationTimeoutMs": validation_timeout_ms,
                }
            current_error = error
            
        return {
            "syncs": [],
            "testFile": editor.test_code,
            "syncFile": editor.sync_code,
            "status": "error",
            "error_log": current_error,
            "aiTouching": ai_touching,
            "validationTimeoutMs": validation_timeout_ms,
        }


    def _run_deno_validation(
        self,
        syncs_code: str,
        test_code: str,
        implementations: Dict[str, Dict[str, str]],
        endpoint_str: str = "Unknown",
        ai_touching: bool = False,
    ) -> tuple[bool, str | None, str | None, List[str]]:
        """
        Runs `deno check` on syncs and `deno test` on tests.
        Returns (deno_passed, check_error, test_error, parsed_syncs).

        - check_error: set if deno check fails (compilation error). test_error will be None.
        - test_error: set if deno test fails. check_error will be None.
        - Both None means deno validation passed.
        
        CRITICAL: This method acquires a lock to ensure only ONE Deno test runs at a time.
        """
        try:
            with self.validation_lock:
                with tempfile.TemporaryDirectory() as temp_dir:
                    self._setup_temp_env(temp_dir, implementations)
                    lock_args = ["--lock=deno.lock"] if os.path.exists(os.path.join(temp_dir, "deno.lock")) else []
                    
                    gen_sync_path = os.path.join(temp_dir, "src", "syncs", "generated.sync.ts")
                    with open(gen_sync_path, "w", encoding="utf-8") as f:
                        f.write(syncs_code)
                    
                    gen_env = os.environ.copy()
                    gen_env["CONCEPTS_DIR"] = os.path.join(temp_dir, "src", "concepts")
                    gen_env["SYNCS_DIR"] = os.path.join(temp_dir, "src", "syncs")
                    
                    print(f"[SyncGen] Step 1: Running generate_imports...", file=sys.stderr)
                    gen_cmd = subprocess.run(
                        ["deno", "run", *lock_args, "--allow-read", "--allow-write", "--allow-env", "--allow-net", os.path.join(temp_dir, "src", "utils", "generate_imports.ts")], 
                        cwd=temp_dir, 
                        env=gen_env,
                        capture_output=True,
                        text=True
                    )
                    
                    if gen_cmd.returncode != 0:
                        return (False, f"Generate Imports Failed:\n{gen_cmd.stderr}\n{gen_cmd.stdout}", None, [])

                    debug_context = ""
                    try:
                        if os.path.exists(os.path.join(temp_dir, "src", "concepts", "index.ts")):
                            with open(os.path.join(temp_dir, "src", "concepts", "index.ts"), "r", encoding="utf-8") as f:
                                debug_context += f"\n\n--- GENERATED src/concepts/index.ts ---\n{f.read()}"
                        
                        test_concepts_path = os.path.join(temp_dir, "src", "concepts", "test_concepts.ts")
                        if os.path.exists(test_concepts_path):
                            with open(test_concepts_path, "r", encoding="utf-8") as f:
                                debug_context += f"\n\n--- GENERATED src/concepts/test_concepts.ts ---\n{f.read()}"
                    except Exception as e:
                        debug_context += f"\n\nError reading context files: {e}"

                    test_path = os.path.join(temp_dir, "src", "tests", "endpoint.test.ts")
                    with open(test_path, "w", encoding="utf-8") as f:
                        f.write(test_code)
                        
                    # Step 2: deno check
                    print(f"[SyncGen] Step 2: deno check on syncs...", file=sys.stderr)
                    check = subprocess.run(["deno", "check", *lock_args, gen_sync_path], capture_output=True, text=True, cwd=temp_dir)
                    if check.returncode != 0:
                        err_msg = f"Sync Compilation Error:\n{check.stderr}"
                        print(f"[SyncGen] deno check FAILED:\n{check.stderr[:500]}", file=sys.stderr)
                        return (False, err_msg, None, [])
                        
                    # Step 3: DB cleanup + deno test
                    requesting_timeout_ms, validation_timeout_ms = resolve_validation_timeouts(ai_touching)
                    env = build_generated_ai_test_env({
                        "REQUESTING_TIMEOUT": str(requesting_timeout_ms),
                    })

                    print(f"[SyncGen] Step 3: DB cleanup (MONGODB_URL={'set' if os.environ.get('MONGODB_URL') else 'MISSING'})...", file=sys.stderr)
                    cleanup_script = """
import { MongoClient } from "npm:mongodb";

const DB_CONN = Deno.env.get("MONGODB_URL");
const DB_NAME = Deno.env.get("DB_NAME");

if (!DB_CONN || !DB_NAME) {
    console.error("Missing DB env vars");
    Deno.exit(1);
}

const client = new MongoClient(DB_CONN);
try {
    await client.connect();
    const testDbName = `test-${DB_NAME}`;
    const db = client.db(testDbName);
    await db.dropDatabase();
} catch (e) {
    console.error(e);
    Deno.exit(1);
} finally {
    await client.close();
}
Deno.exit(0);
"""
                    cleanup_path = os.path.join(temp_dir, "cleanup.ts")
                    with open(cleanup_path, "w", encoding="utf-8") as f:
                        f.write(cleanup_script)
                        
                    cleanup_result = subprocess.run(
                        ["deno", "run", *lock_args, "--allow-net", "--allow-env", "--allow-sys", cleanup_path],
                        cwd=temp_dir, env=env, capture_output=True, text=True, timeout=10
                    )
                    if cleanup_result.returncode != 0:
                        err_msg = f"MongoDB cleanup failed (container cannot reach DB?):\n{cleanup_result.stderr}\n{cleanup_result.stdout}\nEnsure MONGODB_URL uses host.docker.internal when running in Docker."
                        return (False, err_msg, None, [])

                    print(f"[SyncGen] Step 4: Running Deno test for {endpoint_str}...", file=sys.stderr)
                    try:
                        test_cmd = subprocess.run(
                            ["deno", "test", *lock_args, "--allow-all", test_path], 
                            capture_output=True, 
                            text=True, 
                            cwd=temp_dir, 
                            env=env,
                            timeout=max(1, validation_timeout_ms // 1000)
                        )
                        if test_cmd.returncode != 0:
                            err_msg = f"Test Failure:\n{test_cmd.stderr}\n{test_cmd.stdout}"
                            err_msg += debug_context
                            return (False, None, err_msg, [])
                    except subprocess.TimeoutExpired as e:
                        partial_out = e.stdout if e.stdout else ""
                        partial_err = e.stderr if e.stderr else ""
                        return (False, None, f"Test Timeout (Hang detected):\n{partial_err}\n{partial_out}\nPossible causes: Missing await, unclosed resources, or logic deadlock.", [])

            # Extract sync names
            import re
            json_syncs = re.findall(r'export const (\w+): Sync', syncs_code)
            return (True, None, None, json_syncs)
        except Exception as e:
            return (False, f"Validation error: {str(e)}", None, [])

    def _run_review(
        self,
        syncs_code: str,
        test_code: str,
        endpoint_str: str,
        openapi_spec: str,
        relevant_concepts: List[str] | None = None,
        relevant_implementations: str = "",
        implementations: Dict[str, Dict[str, str]] | None = None,
        concept_specs: str = "",
        test_error: str | None = None,
        guidelines: str = ""
    ) -> tuple[bool, str, List[str]]:
        """
        Runs semantic review on syncs/tests. NOT serialized — can run in parallel.
        If test_error is provided, it is included so the reviewer can diagnose test failures.
        Returns (passed, issues_or_empty, reviewer_added_concepts).
        """
        should_run_review = bool(openapi_spec) or bool((relevant_implementations or "").strip())
        if not should_run_review:
            return (True, "", [])
        
        try:
            review_endpoint_info = endpoint_str
            if test_error:
                review_endpoint_info += f"\n\n--- TEST FAILURE (diagnose this) ---\n{test_error[:3000]}"
            
            available_concepts = list((implementations or {}).keys())
            if "Requesting" not in available_concepts:
                available_concepts.append("Requesting")
            selected_concept_specs = self._extract_selected_concept_specs(
                concept_specs,
                relevant_concepts or [],
            )

            ctx = dspy.context(lm=self.flash_lm) if self.flash_lm else nullcontext()
            with ctx:
                review = self.reviewer(
                    endpoint_info=review_endpoint_info,
                    openapi_spec=openapi_spec,
                    syncs_code=syncs_code,
                    test_code=test_code,
                    relevant_concepts=relevant_concepts or [],
                    available_concepts=available_concepts,
                    concept_specs=concept_specs,
                    selected_concept_specs=selected_concept_specs,
                    relevant_implementations=relevant_implementations,
                    guidelines=guidelines
                )
            verdict = (review.verdict or "").strip().upper()
            if verdict != "PASS":
                issues = (review.issues or "").strip()
                reviewer_added_concepts = self._normalize_reviewer_added_concepts(
                    getattr(review, "add_relevant_concepts", []),
                    available_concepts=available_concepts,
                    current_relevant_concepts=relevant_concepts or [],
                )
                print(f"  Reviewer: FAIL — {issues}", file=sys.stderr)
                return (False, f"Review Failed (OpenAPI/concept mismatch):\n{issues}", reviewer_added_concepts)
            print(f"  Reviewer: PASS", file=sys.stderr)
            return (True, "", [])
        except Exception as e:
            return (False, f"Review Error:\n{str(e)}", [])

