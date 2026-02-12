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

class GenerateSyncsAndTests(dspy.Signature):
    """Generate sync definitions and tests for a specific API endpoint.
    
    The syncs should wire the Requesting concept to other concepts to fulfill the endpoint's logic.
    The tests should verify the endpoint behaves as expected, checking concept state changes.
    
    CRITICAL RULES TO FOLLOW:
    
    0. ALWAYS INCLUDE METHOD: Every Requesting.request pattern MUST include the HTTP method.
       BAD: { path: "/auth/logout", accessToken }
       GOOD: { path: "/auth/logout", method: "POST", accessToken }
    
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
    """Review generated syncs/tests for OpenAPI compliance.
    
    Return PASS only if the response shapes and required fields match the spec.
    If anything deviates (missing wrapper objects, wrong field types, missing fields),
    return FAIL with a precise list of issues.
    """
    
    endpoint_info: str = dspy.InputField(desc="JSON string with method, path, summary, description.")
    openapi_spec: str = dspy.InputField(desc="The full OpenAPI specification.")
    syncs_code: str = dspy.InputField(desc="Generated syncs code for the endpoint.")
    test_code: str = dspy.InputField(desc="Generated tests for the endpoint.")
    
    verdict: str = dspy.OutputField(desc="PASS or FAIL")
    issues: str = dspy.OutputField(desc="Specific, actionable issues if FAIL. Otherwise 'none'.")

class AgentStep(dspy.Signature):
    """Analyze errors and propose a tool action to fix syncs or tests.
    
    COMMON ERROR PATTERNS AND FIXES:
    
    1. "Sync didn't fire" / "Request timed out" -> Check if `when` pattern includes optional fields.
       FIX: Remove optional fields from `when`, handle them in `where` with frames.map.
       
    2. "Action called in where" -> Never call actions in where clauses.
       FIX: Move action calls to `then` clause. Use separate syncs for success/error.
       
    3. "Missing response" -> Check if Requesting.respond is in `then` with correct bindings.
       FIX: Ensure `request` symbol is passed through from `when`.
       
    4. "Pattern mismatch" on optional fields -> Test sent request without optional field.
       FIX: Only include guaranteed fields in `when` pattern.
    
    5. "Property does not exist on type" -> Method doesn't exist on the concept.
       FIX: Rewrite sync using methods from `relevant_implementations`. NEVER use `declare module` — crashes at runtime.
    """
    
    endpoint: str = dspy.InputField()
    file_contents: str = dspy.InputField(desc="Current syncs.ts and test.ts contents.") 
    error_log: str = dspy.InputField(desc="Test failure output or validation errors.")
    previous_actions: str = dspy.InputField(desc="History of fixes.")
    relevant_implementations: str = dspy.InputField(desc="Code of relevant concepts already in context.")
    guidelines: str = dspy.InputField(desc="Patterns for syncs and testing. Contains CRITICAL RULES.")
    
    thought: str = dspy.OutputField(desc="Reasoning about the fix. Consider: Is this a pattern matching issue? Are actions in where? Are optional fields handled correctly?")
    tool_name: str = dspy.OutputField(desc="replace, delete, insert_after, overwrite, read_concept, run_tests, finish")
    tool_args: str = dspy.OutputField(desc="JSON string of arguments. replace: {'target': 'syncs'|'tests', 'old_code': '...', 'new_code': '...'}, delete: {'target': 'syncs'|'tests', 'code_to_delete': '...'}, insert_after: {'target': 'syncs'|'tests', 'after_code': '...', 'new_code': '...'}, overwrite: {'target': 'syncs'|'tests', 'new_code': '...'} or {'syncs': '...', 'tests': '...'}, read_concept: {'concepts': ['ConceptName1', 'ConceptName2']}, run_tests/finish: {}. CRITICAL: target MUST be 'syncs' or 'tests' only. NEVER use 'database' or 'impl'.")

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

        deno_json = {
            "imports": {
                "@concepts": "./src/concepts/index.ts",
                "@engine": "./src/engine/mod.ts",
                "@syncs": "./src/syncs/syncs.ts",
                "@utils/": real_utils_uri,
                "npm:": "npm:",
                "jsr:": "jsr:"
            }
        }
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

        guidelines = (
            f"{context_docs}"
            "=== SYNC GENERATION RULES ===\n\n"
            
            "### RULE 0: ALWAYS Include `method` in Request Patterns ###\n"
            "Every `Requesting.request` pattern MUST include the HTTP method.\n"
            "  BAD: `{ path: \"/auth/logout\", accessToken }`\n"
            "  GOOD: `{ path: \"/auth/logout\", method: \"POST\", accessToken }`\n\n"
            
            "### RULE 1: Pattern Matching is STRICT on Undefined Fields ###\n"
            "If a field is in the `when` pattern but undefined/missing in the request, the pattern will NOT match.\n"
            "  BAD - if bioImageUrl is not in request, sync won't fire:\n"
            "    { path: \"/profiles\", method: \"POST\", accessToken, username, name, bio, bioImageUrl }\n"
            "  GOOD - only include fields that are GUARANTEED to be present:\n"
            "    { path: \"/profiles\", method: \"POST\", accessToken, username, name, bio }\n"
            "  Then handle optional fields in `where` clause using frames.map to extract them if present.\n\n"
            
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
            "This pattern ensures proper handling of async operations and errors.\n\n"
            
            "### RULE 4: Use SELF-CONTAINED Pattern for Reads (GET) ###\n"
            "For read operations, handle everything in ONE sync:\n"
            "  - `when`: match the request\n"
            "  - `where`: authenticate + query data (using _ prefixed query methods)\n"
            "  - `then`: respond directly with the queried data\n"
            "No need for separate success/error syncs for reads.\n\n"
            
            "### RULE 5: Concepts Must Handle Optional Parameters ###\n"
            "If an API field is optional, the concept method should:\n"
            "  - Type the parameter as optional: `bio?: string`\n"
            "  - Provide a default value: `bio: bio ?? \"\"`\n"
            "This prevents undefined values from breaking the sync.\n\n"
            
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
            "    - Option A: Write the test to explicitly send `key: undefined`.\n"
            "    - Option B: Write a single Sync that matches the base request (omit `key` from `when`) and use `frames.map` in `where` to handle the logic (checking if `f['key']` exists/matches).\n"
            "    - Option C: Write two Syncs, but ensure the 'base' Sync (without key) excludes the other case in its `where` clause (e.g. `frames.filter(f => !f['key'])`) rather than in `when`.\n"
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
            "20. MongoDB `_id` fields are `ObjectId`, not strings. In syncs, always stringify: `_id: String(doc._id)`. In tests, compare as strings.\n"
            "21. CRITICAL: ONLY reference methods that exist in `relevant_implementations`. NEVER use `declare module` to invent methods — it passes `deno check` but CRASHES at runtime. Restructure sync logic using methods that DO exist."
        )
        
        endpoint_str = json.dumps(endpoint)
        
        # 1. Select Relevant Concepts
        print(f"Selecting relevant concepts for {endpoint.get('method')} {endpoint.get('path')}...", file=sys.stderr)
        
        # Prepare available concepts list (Requesting is always available)
        available_concepts_list = list(implementations.keys())
        if "Requesting" not in available_concepts_list:
            available_concepts_list.append("Requesting")
        
        relevant_concepts = []
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
            
            if not relevant_concepts:
                print(f"Concept selector returned empty or invalid list (attempt {attempt + 1}/{max_selector_retries}). Raw: {raw_concepts}. Retrying...", file=sys.stderr)
                continue
            
            # Success - we have valid concepts
            break
        else:
            # All retries exhausted
            print(f"WARNING: Concept selector failed after {max_selector_retries} attempts. Proceeding with no concepts.", file=sys.stderr)
            relevant_concepts = []
        
        # Enforce heuristic: If Authenticating is present, Sessioning is likely needed
        if "Authenticating" in relevant_concepts and "Sessioning" not in relevant_concepts:
            if "Sessioning" in available_concepts_list:
                print("Auto-adding Sessioning concept because Authenticating is present.", file=sys.stderr)
                relevant_concepts.append("Sessioning")
             
        print(f"Selected concepts: {relevant_concepts}", file=sys.stderr)
        
        relevant_implementations_str = ""
        for concept in relevant_concepts:
            if concept == "Requesting":
                continue # Requesting is built-in and always available
            if concept in implementations:
                code = implementations[concept].get("code", "")
                relevant_implementations_str += f"--- CONCEPT: {concept} ---\n{code}\n\n"
            else:
                print(f"Warning: Selected concept '{concept}' not found in implementations.", file=sys.stderr)
        
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
        
        # Fix Loop
        return self._fix_loop(endpoint_str, syncs_code, test_code, implementations, relevant_implementations_str, guidelines, openapi_spec, max_iterations=max_fix_iterations)

    def _fix_loop(self, endpoint: str, syncs_code: str, test_code: str, implementations: Dict[str, Dict[str, str]], relevant_implementations_str: str, guidelines: str, openapi_spec: str, max_iterations: int = 10) -> Dict[str, Any]:
        editor = CodeEditor(syncs_code, test_code)
        current_error = None
        history = []
        
        # Initial Check
        success, error, json_syncs = self._run_validation(editor.sync_code, editor.test_code, implementations, endpoint, openapi_spec)
        if success:
            return {
                "syncs": json_syncs,
                "testFile": editor.test_code,
                "syncFile": editor.sync_code,
                "status": "complete"
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
                        guidelines=guidelines
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
            
            result_msg = ""
            log_target = tool_args.get("target")
            if tool_name == "overwrite" and "syncs" in tool_args and "tests" in tool_args:
                log_target = "syncs+tests"
            elif log_target is None:
                log_target = "?"
            print(f"  Agent: {tool_name} on {log_target}", file=sys.stderr)

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
                pass # Handled after
            elif tool_name == "finish":
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
            
            # Re-validate
            success, error, json_syncs = self._run_validation(editor.sync_code, editor.test_code, implementations, endpoint, openapi_spec)
            if success:
                return {
                    "syncs": json_syncs,
                    "testFile": editor.test_code,
                    "syncFile": editor.sync_code,
                    "status": "complete"
                }
            current_error = error
            
        return {
            "syncs": [], # Failed
            "testFile": editor.test_code,
            "syncFile": editor.sync_code,
            "status": "error",
            "error_log": current_error
        }


    def _run_validation(self, syncs_code: str, test_code: str, implementations: Dict[str, Dict[str, str]], endpoint_str: str = "Unknown", openapi_spec: str = "") -> tuple[bool, str, List[Dict]]:
        """
        Runs `deno check` on syncs and `deno test` on tests.
        Returns (success, error_log, parsed_syncs).
        
        CRITICAL: This method acquires a lock to ensure only ONE Deno test runs at a time.
        """
        try:
            # --- Phase 1: Deno validation (serialized) ---
            debug_context = ""
            with self.validation_lock:
                with tempfile.TemporaryDirectory() as temp_dir:
                    self._setup_temp_env(temp_dir, implementations)
                    lock_args = ["--lock=deno.lock"] if os.path.exists(os.path.join(temp_dir, "deno.lock")) else []
                    
                    # Write agent's code to generated.sync.ts
                    gen_sync_path = os.path.join(temp_dir, "src", "syncs", "generated.sync.ts")
                    with open(gen_sync_path, "w", encoding="utf-8") as f:
                        f.write(syncs_code)
                    
                    # Run generate_imports.ts to build syncs.ts properly
                    # --allow-net required: JSR imports (jsr:@std/path, jsr:@std/fs) need network in fresh Docker env
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
                        return (False, f"Generate Imports Failed:\n{gen_cmd.stderr}\n{gen_cmd.stdout}", [])
 
                    # Read generated context files for debug info
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
                        
                    # 1. Check Sync Syntax
                    print(f"[SyncGen] Step 2: deno check on syncs...", file=sys.stderr)
                    check = subprocess.run(["deno", "check", *lock_args, gen_sync_path], capture_output=True, text=True, cwd=temp_dir)
                    if check.returncode != 0:
                        err_msg = f"Sync Compilation Error:\n{check.stderr}"
                        print(f"[SyncGen] deno check FAILED:\n{check.stderr[:500]}", file=sys.stderr)
                        return (False, err_msg, [])
                        
                    # 2. Run Tests
                    env = os.environ.copy()
                    env["DB_NAME"] = "sync_gen_validation_temp_db"
                    env["REQUESTING_TIMEOUT"] = "10000"
 
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
    const db = client.db(DB_NAME);
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
                        return (False, err_msg, [])

                    print(f"[SyncGen] Step 4: Running Deno test for {endpoint_str}...", file=sys.stderr)
                    try:
                        test_cmd = subprocess.run(
                            ["deno", "test", *lock_args, "--allow-all", test_path], 
                            capture_output=True, 
                            text=True, 
                            cwd=temp_dir, 
                            env=env,
                            timeout=30
                        )
                        if test_cmd.returncode != 0:
                            err_msg = f"Test Failure:\n{test_cmd.stderr}\n{test_cmd.stdout}"
                            err_msg += debug_context
                            return (False, err_msg, [])
                    except subprocess.TimeoutExpired as e:
                        partial_out = e.stdout if e.stdout else ""
                        partial_err = e.stderr if e.stderr else ""
                        return (False, f"Test Timeout (Hang detected):\n{partial_err}\n{partial_out}\nPossible causes: Missing await, unclosed resources, or logic deadlock.", [])

            # --- Phase 2: Flash Review (concurrent across threads) ---
            if openapi_spec:
                try:
                    ctx = dspy.context(lm=self.flash_lm) if self.flash_lm else nullcontext()
                    with ctx:
                        review = self.reviewer(
                            endpoint_info=endpoint_str,
                            openapi_spec=openapi_spec,
                            syncs_code=syncs_code,
                            test_code=test_code
                        )
                    verdict = (review.verdict or "").strip().upper()
                    if verdict != "PASS":
                        issues = (review.issues or "").strip()
                        return (False, f"Flash Review Failed (OpenAPI mismatch):\n{issues}", [])
                except Exception as e:
                    return (False, f"Flash Review Error:\n{str(e)}", [])
            
            # 3. Extract sync names using regex (faster than spawning Deno)
            import re
            json_syncs = re.findall(r'export const (\w+): Sync', syncs_code)
            return (True, "", json_syncs)
        except Exception as e:
            return (False, f"Validation error: {str(e)}", [])

