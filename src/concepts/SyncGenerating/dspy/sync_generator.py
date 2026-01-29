import dspy
import json
import os
import sys
import tempfile
# import time
import concurrent.futures
import subprocess
from typing import Any, Dict, List, Optional
from pydantic import BaseModel

# --- Signatures ---

class SelectRelevantConcepts(dspy.Signature):
    """Determine which concepts are relevant for implementing the syncs for a specific endpoint.
    
    IMPORTANT: If 'Authenticating' is relevant, 'Sessioning' is almost ALWAYS relevant for session management (creating tokens on login/register).
    Always include 'Sessioning' if 'Authenticating' is selected.

    CRITICAL: You MUST ONLY select concepts from the `available_concepts` list. Do NOT invent new concepts or select concepts that are not in this list.
    """
    
    endpoint_info: str = dspy.InputField()
    plan: str = dspy.InputField()
    concept_specs: str = dspy.InputField()
    available_concepts: List[str] = dspy.InputField(desc="List of available concept names. ONLY select from this list.")
    
    thought: str = dspy.OutputField()
    relevant_concepts: List[str] = dspy.OutputField(desc="List of concept names whose implementations are needed. Must be a subset of available_concepts.")

class GenerateSyncsAndTests(dspy.Signature):
    """Generate sync definitions and tests for a specific API endpoint.
    
    The syncs should wire the Requesting concept to other concepts to fulfill the endpoint's logic.
    The tests should verify the endpoint behaves as expected, checking concept state changes.
    """
    
    endpoint_info: str = dspy.InputField(desc="JSON string with method, path, summary, description.")
    plan: str = dspy.InputField(desc="Overall project plan.")
    concept_specs: str = dspy.InputField(desc="Specs of all available concepts.")
    relevant_implementations: str = dspy.InputField(desc="Code of relevant concepts.")
    guidelines: str = dspy.InputField(desc="Patterns for syncs and testing.")
    
    syncs_code: str = dspy.OutputField(desc="TypeScript code exporting individual `export const Name: Sync = ...` definitions. NO default export.")
    test_code: str = dspy.OutputField(desc="Deno test file content.")

class AgentStep(dspy.Signature):
    """Analyze errors and propose a tool action to fix syncs or tests."""
    
    endpoint: str = dspy.InputField()
    file_contents: str = dspy.InputField(desc="Current syncs.ts and test.ts contents.") 
    error_log: str = dspy.InputField(desc="Test failure output or validation errors.")
    previous_actions: str = dspy.InputField(desc="History of fixes.")
    relevant_implementations: str = dspy.InputField(desc="Code of relevant concepts already in context.")
    
    thought: str = dspy.OutputField(desc="Reasoning about the fix.")
    tool_name: str = dspy.OutputField(desc="replace, delete, insert_after, overwrite, read_concept, run_tests, finish")
    tool_args: str = dspy.OutputField(desc="JSON string of arguments. replace: {'target': 'syncs'|'tests', 'old_code': '...', 'new_code': '...'}, delete: {'target': 'syncs'|'tests', 'code_to_delete': '...'}, insert_after: {'target': 'syncs'|'tests', 'after_code': '...', 'new_code': '...'}, overwrite: {'target': 'syncs'|'tests', 'new_code': '...'} or {'syncs': '...', 'tests': '...'}, read_concept: {'concepts': ['ConceptName1', 'ConceptName2']}, run_tests/finish: {}")

# --- Helper Classes ---

class CodeEditor:
    def __init__(self, sync_code: str, test_code: str):
        self.sync_code = sync_code
        self.test_code = test_code

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
            current = self.get_code(target)
            if old_code not in current:
                return f"Error: old_code not found in {target}."
            if current.count(old_code) > 1:
                return f"Error: old_code found {current.count(old_code)} times. Provide unique context."
            self.set_code(target, current.replace(old_code, new_code))
            return "Success: Code replaced."
        except Exception as e:
            return f"Error: {str(e)}"

    def delete(self, target: str, code_to_delete: str) -> str:
        try:
            current = self.get_code(target)
            if code_to_delete not in current:
                return f"Error: code_to_delete not found in {target}."
            self.set_code(target, current.replace(code_to_delete, ""))
            return "Success: Code deleted."
        except Exception as e:
            return f"Error: {str(e)}"

    def insert_after(self, target: str, after_code: str, new_code: str) -> str:
        try:
            current = self.get_code(target)
            if after_code not in current:
                return f"Error: after_code not found in {target}."
            self.set_code(target, current.replace(after_code, after_code + "\n" + new_code))
            return "Success: Code inserted."
        except Exception as e:
            return f"Error: {str(e)}"

    def overwrite(self, target: str, new_code: str) -> str:
        try:
            self.set_code(target, new_code)
            return "Success: File overwritten."
        except Exception as e:
            return f"Error: {str(e)}"

# --- Main Generator ---

class SyncGenerator(dspy.Module):
    def __init__(self):
        super().__init__()
        self.concept_selector = dspy.ChainOfThought(SelectRelevantConcepts)
        self.generator = dspy.ChainOfThought(GenerateSyncsAndTests)
        self.agent_step = dspy.ChainOfThought(AgentStep)

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
            
    def generate_syncs(self, endpoint: Dict[str, Any], plan: Dict[str, Any], concept_specs: str, implementations: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
        """
        Generates syncs and tests for an endpoint, with a fix loop.
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
            
            # 3. Generated Examples (Ground Truth for this project)
            examples_path = os.path.join(current_dir, "generated_examples.md")
            if os.path.exists(examples_path):
                with open(examples_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- GENERATED EXAMPLES (Reference these patterns!) ---\n{f.read()}\n\n"

            # 6. Database Utils (freshID, etc.)
            db_path = os.path.join(repo_root, "src/utils/database.ts")
            if os.path.exists(db_path):
                with open(db_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- DATABASE UTILS (src/utils/database.ts) ---\n{f.read()}\n\n"

            # 7. Requesting Concept (Infrastructure)
            req_path = os.path.join(repo_root, "src/concepts/Requesting/RequestingConcept.ts")
            if os.path.exists(req_path):
                with open(req_path, "r", encoding="utf-8") as f:
                    context_docs += f"--- REQUESTING CONCEPT (src/concepts/Requesting/RequestingConcept.ts) ---\n{f.read()}\n\n"

        except Exception:
            pass

        guidelines = (
            f"{context_docs}"
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
            "17. CRITICAL: Do NOT try to index frames with action functions like `$[Sessioning.delete]`. Frames are indexed by Symbols, not functions. To check if an action produced an error, use separate syncs for success/error cases with different `when` patterns, rather than checking action outputs in `where`."
        )
        
        endpoint_str = json.dumps(endpoint)
        
        # 1. Select Relevant Concepts
        print(f"Selecting relevant concepts for {endpoint.get('method')} {endpoint.get('path')}...", file=sys.stderr)
        
        # Prepare available concepts list (Requesting is always available)
        available_concepts_list = list(implementations.keys())
        if "Requesting" not in available_concepts_list:
            available_concepts_list.append("Requesting")
            
        selector_res = self.concept_selector(
            endpoint_info=endpoint_str,
            plan=json.dumps(plan),
            concept_specs=concept_specs,
            available_concepts=available_concepts_list
        )
        
        relevant_concepts = selector_res.relevant_concepts
        
        # Enforce heuristic: If Authenticating is present, Sessioning is likely needed
        if "Authenticating" in relevant_concepts and "Sessioning" not in relevant_concepts:
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
        
        try:
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(self.generator, 
                    endpoint_info=endpoint_str,
                    plan=json.dumps(plan),
                    concept_specs=concept_specs,
                    relevant_implementations=relevant_implementations_str,
                    guidelines=guidelines
                )
                pred = future.result(timeout=240) # 4 minute timeout

            syncs_code = self._clean_code(pred.syncs_code)
            test_code = self._clean_code(pred.test_code)
        except concurrent.futures.TimeoutError:
             print("LLM Call Timed Out!", file=sys.stderr)
             return { "syncs": [], "testFile": "", "syncFile": "", "status": "error", "error": "LLM Timeout" }
        except Exception as e:
             print(f"LLM Call Failed: {e}", file=sys.stderr)
             return { "syncs": [], "testFile": "", "syncFile": "", "status": "error", "error": str(e) }
        
        print(f"\n--- INITIAL GENERATED SYNC CODE ---\n{syncs_code}\n", file=sys.stderr)
        print(f"\n--- INITIAL GENERATED TEST CODE ---\n{test_code}\n", file=sys.stderr)
        
        # Fix Loop
        return self._fix_loop(endpoint_str, syncs_code, test_code, implementations, relevant_implementations_str)

    def _fix_loop(self, endpoint: str, syncs_code: str, test_code: str, implementations: Dict[str, Dict[str, str]], relevant_implementations_str: str, max_iterations: int = 100) -> Dict[str, Any]:
        editor = CodeEditor(syncs_code, test_code)
        current_error = None
        history = []
        
        # Initial Check
        success, error, json_syncs = self._run_validation(editor.sync_code, editor.test_code, implementations)
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
            
            pred = self.agent_step(
                endpoint=endpoint,
                file_contents=files_context,
                error_log=current_error or "Run validation",
                previous_actions="\n".join(history),
                relevant_implementations=relevant_implementations_str
            )
            
            print(f"Agent Thought: {pred.thought}", file=sys.stderr)
            
            tool_name = pred.tool_name
            tool_args = {}
            try:
                tool_args = json.loads(pred.tool_args)
            except:
                pass
            
            result_msg = ""
            print(f"Agent Action: {tool_name} {json.dumps(tool_args)}", file=sys.stderr)

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
                concepts_to_read = tool_args.get("concepts", [])
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
            
            # Show test errors if any to the terminal
            if current_error:
                 print(f"Test Output:\n{current_error[:2000]}...", file=sys.stderr)

            print(f"Result: {result_msg[:200] if result_msg else 'Done'}...", file=sys.stderr)

            history.append(f"Thought: {pred.thought}\nAction: {tool_name} Args: {json.dumps(tool_args)}, Result: {result_msg}")
            
            # Re-validate
            success, error, json_syncs = self._run_validation(editor.sync_code, editor.test_code, implementations)
            if success:
                return {
                    "syncs": json_syncs,
                    "testFile": editor.test_code,
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


    def _run_validation(self, syncs_code: str, test_code: str, implementations: Dict[str, Dict[str, str]]) -> tuple[bool, str, List[Dict]]:
        """
        Runs `deno check` on syncs and `deno test` on tests.
        Returns (success, error_log, parsed_syncs).
        """
        with tempfile.TemporaryDirectory() as temp_dir:
            self._setup_temp_env(temp_dir, implementations)
            
            # Write agent's code to generated.sync.ts
            gen_sync_path = os.path.join(temp_dir, "src", "syncs", "generated.sync.ts")
            with open(gen_sync_path, "w", encoding="utf-8") as f:
                f.write(syncs_code)
            
            # Run generate_imports.ts to build syncs.ts properly
            # We need to set CONCEPTS_DIR and SYNCS_DIR env vars to point to our temp directories
            gen_env = os.environ.copy()
            gen_env["CONCEPTS_DIR"] = os.path.join(temp_dir, "src", "concepts")
            gen_env["SYNCS_DIR"] = os.path.join(temp_dir, "src", "syncs")
            
            # The script requires permissions to read/write files
            gen_cmd = subprocess.run(
                ["deno", "run", "--allow-read", "--allow-write", "--allow-env", os.path.join(temp_dir, "src", "utils", "generate_imports.ts")], 
                cwd=temp_dir, 
                env=gen_env,
                capture_output=True,
                text=True
            )
            
            if gen_cmd.returncode != 0:
                 return (False, f"Generate Imports Failed:\n{gen_cmd.stderr}\n{gen_cmd.stdout}", [])

            # DEBUG: Print generated syncs.ts to check for compilation issues
            shim_path = os.path.join(temp_dir, "src", "syncs", "syncs.ts")
            if os.path.exists(shim_path):
                with open(shim_path, "r", encoding="utf-8") as f:
                    print(f"--- GENERATED syncs.ts ---\n{f.read()}\n--------------------------", file=sys.stderr)

            test_path = os.path.join(temp_dir, "src", "tests", "endpoint.test.ts")
            with open(test_path, "w", encoding="utf-8") as f:
                f.write(test_code)
                
            # 1. Check Sync Syntax (Check the agent's generated file directly)
            # Using --allow-all because we import from @concepts which are local files
            check = subprocess.run(["deno", "check", gen_sync_path], capture_output=True, text=True, cwd=temp_dir)
            if check.returncode != 0:
                return (False, f"Sync Compilation Error:\n{check.stderr}", [])
                
            # 2. Run Tests
            env = os.environ.copy()
            # Use a fixed DB name to avoid running out of databases (limit 100)
            env["DB_NAME"] = "sync_gen_validation_temp_db"
            # Reduce Requesting timeout to 25s for tests to avoid long hangs on failure
            env["REQUESTING_TIMEOUT"] = "25000"

            print("Running DB cleanup...", file=sys.stderr)
            # Create cleanup script to clear the DB before test
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
                // console.log(`Dropped database: ${DB_NAME}`);
            } catch (e) {
                console.error(e);
            } finally {
                await client.close();
            }
            Deno.exit(0);
            """
            cleanup_path = os.path.join(temp_dir, "cleanup.ts")
            with open(cleanup_path, "w", encoding="utf-8") as f:
                f.write(cleanup_script)
                
            # Run cleanup with timeout
            # We need --allow-net to connect to mongo, --allow-env for vars, --allow-sys for mongo driver info
            subprocess.run(["deno", "run", "--allow-net", "--allow-env", "--allow-sys", cleanup_path], cwd=temp_dir, env=env, capture_output=True, timeout=10)

            print(f"Running Deno test... (Timeout: {env.get('REQUESTING_TIMEOUT')}ms)", file=sys.stderr)
            try:
                # Add a subprocess timeout to kill the test if it hangs (e.g. 30s to allow internal 25s timeout to trigger)
                test_cmd = subprocess.run(
                    ["deno", "test", "--allow-all", test_path], 
                    capture_output=True, 
                    text=True, 
                    cwd=temp_dir, 
                    env=env,
                    timeout=30 # 30 seconds max runtime
                )
                if test_cmd.returncode != 0:
                    return (False, f"Test Failure:\n{test_cmd.stderr}\n{test_cmd.stdout}", [])
            except subprocess.TimeoutExpired as e:
                # Capture any partial output if possible (stdout/stderr might be bytes or None)
                partial_out = e.stdout if e.stdout else ""
                partial_err = e.stderr if e.stderr else ""
                return (False, f"Test Timeout (Hang detected):\n{partial_err}\n{partial_out}\nPossible causes: Missing await, unclosed resources, or logic deadlock.", [])
                 
            # 3. Extract JSON from generated syncs
            # We run a small script to import syncs and print JSON
            # Deno.exit(0) is crucial because importing syncs connects to the DB, keeping the process alive.
            extractor = """
            // Silence console.log during import to avoid polluting JSON output
            const originalLog = console.log;
            console.log = () => {};
            try {
                const syncs = await import("./src/syncs/generated.sync.ts");
                console.log = originalLog;
                
                // Convert module to simple object with keys, as functions don't stringify
                const exportNames = Object.keys(syncs);
                console.log(JSON.stringify(exportNames));
            } catch (e) {
                console.log = originalLog;
                console.error(e);
                Deno.exit(1);
            }
            Deno.exit(0);
            """
            extract_path = os.path.join(temp_dir, "extract.ts")
            with open(extract_path, "w", encoding="utf-8") as f:
                f.write(extractor)
            
            extract_cmd = subprocess.run(["deno", "run", "--allow-read", "--allow-env", "--allow-net", "--allow-sys", extract_path], capture_output=True, text=True, cwd=temp_dir)
            if extract_cmd.returncode != 0:
                return (False, f"Failed to extract JSON from syncs:\n{extract_cmd.stderr}", [])
                
            try:
                json_syncs = json.loads(extract_cmd.stdout)
                return (True, "", json_syncs)
            except:
                return (False, "Failed to parse extracted JSON", [])

