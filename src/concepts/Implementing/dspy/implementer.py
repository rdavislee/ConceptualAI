import dspy
import os
import json
import sys
import time
sys.dont_write_bytecode = True
import tempfile
import subprocess
import shutil
import atexit
import re
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv
from pydantic import BaseModel, Field


def _retry_on_truncation(callable_fn, is_valid_fn, max_attempts: int = 3, label: str = "LM call"):
    """Retry when output is invalid/truncated (no token/setting changes)."""
    result = None
    for attempt in range(max_attempts):
        result = callable_fn()
        if is_valid_fn(result):
            return result
        if attempt < max_attempts - 1:
            print(f"[Implementing] {label} produced invalid/truncated output (attempt {attempt + 1}/{max_attempts}), retrying...", file=sys.stderr)
            time.sleep(2)
    return result

# Setup unique cache dir to prevent ANY persistence
# We do this at module level so it applies to this process instance
CACHE_DIR = tempfile.mkdtemp(prefix="dspy_agent_cache_")
os.environ["DSPY_CACHEDIR"] = CACHE_DIR

def cleanup_cache():
    if os.path.exists(CACHE_DIR):
        try:
            shutil.rmtree(CACHE_DIR, ignore_errors=True)
        except Exception:
            pass

atexit.register(cleanup_cache)

load_dotenv()

# Configure Gemini
api_key = os.getenv("GEMINI_API_KEY")
model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-pro")

if not api_key:
    print("Warning: GEMINI_API_KEY not found in environment variables.", file=sys.stderr)

# Fix model name for dspy/litellm compatibility
if not model_name.startswith("gemini/") and "gemini" in model_name:
    model_name = f"gemini/{model_name}"

# Disable caching to ensure fresh generation every time and avoid "immediate" skips
lm = dspy.LM(model=model_name, api_key=api_key, max_tokens=64000, cache=False, temperature=0.5)
dspy.settings.configure(lm=lm)

class GenerateImplementation(dspy.Signature):
    """Generate TypeScript implementation for a concept spec.
    CRITICAL: Output ONLY valid TypeScript code for the class. 
    - DO NOT include the specification text.
    - DO NOT use markdown code blocks (```ts). Just raw code or code blocks are fine, but clean code is best.
    - Start with imports.
    - Include the class definition with all actions and queries.
    """
    
    spec: str = dspy.InputField(desc="The full markdown specification of the concept.")
    context: str = dspy.InputField(desc="Architectural context and patterns.")
    reference_examples: str = dspy.InputField(desc="Reference implementation of a similar concept.")
    previous_implementation: Optional[str] = dspy.InputField(desc="Existing implementation code if updating.", default=None)
    
    typescript_code: str = dspy.OutputField(desc="The complete TypeScript class implementation. CODE ONLY.")

class GenerateTests(dspy.Signature):
    """Generate Deno tests for a concept implementation.
    CRITICAL: Output ONLY valid TypeScript/Deno test code.
    - DO NOT include the specification text.
    - Start with imports.
    - MUST import `testDb` from "@utils/database.ts".
    - NEVER use `mongodb-memory-server`.
    - NEVER define local mocks like `MockDb`, `MockCollection`, or a local `testDb` function.
    """
    
    spec: str = dspy.InputField(desc="The full markdown specification of the concept.")
    implementation_code: str = dspy.InputField(desc="The TypeScript implementation to test.")
    context: str = dspy.InputField(desc="Testing strategies and patterns.")
    reference_examples: str = dspy.InputField(desc="Reference tests of a similar concept.")
    previous_tests: Optional[str] = dspy.InputField(desc="Existing tests if updating.", default=None)
    
    test_code: str = dspy.OutputField(desc="The complete Deno test file. CODE ONLY.")

class SelectReferenceConcepts(dspy.Signature):
    """Select the most relevant library concepts to use as reference implementations.
    
    You MUST always select at least one concept. Even when no concept is a close semantic
    match, library concepts share structural patterns (MongoDB collection setup, CRUD action
    signatures, query return formats, ID/freshID usage, error handling) that are valuable
    as reference. Prefer structural similarity (similar state shape, CRUD patterns, or
    query styles) when semantic similarity is low.
    
    NEVER return 'None' or an empty list.
    """
    
    concept_name: str = dspy.InputField(desc="The name of the concept being implemented.")
    spec: str = dspy.InputField(desc="The specification of the concept being implemented.")
    available_library_concepts: str = dspy.InputField(desc="List of available library concepts and their specs.")
    
    selected_concepts: str = dspy.OutputField(desc="A comma-separated list of the best matching library concepts to use as reference (e.g., 'Posting, Commenting'). MUST contain at least one concept. Prefer structural similarity when semantic similarity is low.")
    reasoning: str = dspy.OutputField(desc="Why these library concepts are good references for the concept being implemented.")

class AgentStep(dspy.Signature):
    """Analyze the error and code, and propose a tool action to fix it."""
    spec: str = dspy.InputField(desc="The concept specification.")
    file_contents: str = dspy.InputField(desc="Current contents of implementation and test files.") 
    error_log: str = dspy.InputField(desc="Test failure output or user feedback.")
    previous_actions: str = dspy.InputField(desc="History of what has been done.")
    
    thought: str = dspy.OutputField(desc="Reasoning about what to do next.")
    tool_name: str = dspy.OutputField(desc="One of: replace, delete, insert_after, overwrite, run_tests, finish")
    tool_args: str = dspy.OutputField(desc="JSON string of arguments. replace: {'target': 'impl'|'test', 'old_code': '...', 'new_code': '...'}, delete: {'target': 'impl'|'test', 'code_to_delete': '...'}, insert_after: {'target': 'impl'|'test', 'after_code': '...', 'new_code': '...'}, overwrite: {'target': 'impl'|'test', 'new_code': '...'} or {'impl': '...', 'test': '...'}, run_tests/finish: {}. CRITICAL: target MUST be 'impl' or 'test' only. NEVER use 'database', 'syncs', or 'tests'.")

def _normalize_for_match(s: str) -> str:
    """Normalize string for matching - handles CRLF/LF differences across platforms (e.g. Docker Linux vs Windows)."""
    if not s:
        return s
    return s.replace("\r\n", "\n").replace("\r", "\n").strip()


def _validate_test_strategy(test_code: str) -> tuple[bool, str]:
    """Enforce real DB integration tests (no mocks/in-memory substitutes)."""
    code = test_code or ""

    # Disallow local mocking/in-memory patterns that bypass real DB behavior.
    disallowed_patterns = [
        (r"\bclass\s+MockCollection\b", "Do not use mocked Mongo collections."),
        (r"\bclass\s+MockDb\b", "Do not use mocked DB implementations."),
        (r"\b(?:async\s+)?function\s+testDb\s*\(", "Do not define a local testDb; import it from @utils/database.ts."),
        (r"\b(?:const|let|var)\s+testDb\s*=", "Do not define a local testDb; import it from @utils/database.ts."),
        (r"mongodb-memory-server", "Do not use mongodb-memory-server."),
        (r"MongoMemoryServer", "Do not use mongodb-memory-server."),
    ]
    for pattern, message in disallowed_patterns:
        if re.search(pattern, code, flags=re.IGNORECASE):
            return (False, f"Test strategy violation: {message}")

    # Require canonical test DB import and usage.
    has_testdb_import = re.search(
        r'import\s*\{[^}]*\btestDb\b[^}]*\}\s*from\s*["\']@utils/database\.ts["\']',
        code,
        flags=re.IGNORECASE,
    )
    if not has_testdb_import:
        return (False, "Test strategy violation: Tests must import testDb from @utils/database.ts.")

    if not re.search(r"\btestDb\s*\(", code):
        return (False, "Test strategy violation: Tests must call testDb().")

    if "await client.close()" not in code:
        return (False, "Test strategy violation: Tests must close the Mongo client in finally.")

    return (True, "")


class CodeEditor:
    def __init__(self, impl_code: str, test_code: str):
        self.impl = impl_code
        self.tests = test_code

    def _validate_target(self, target: str) -> str | None:
        """Returns error message if target is invalid, else None."""
        if target in ("impl", "test"):
            return None
        if target in ("database", "syncs", "tests"):
            return f"Error: target must be 'impl' or 'test' only. You used '{target}'. Fix impl with target:'impl', fix tests with target:'test'."
        return f"Error: Unknown target: {target}. Valid targets are 'impl' and 'test' only."

    def get_code(self, target: str) -> str:
        if target == "impl": return self.impl
        if target == "test": return self.tests
        raise ValueError(f"Unknown target: {target}")

    def set_code(self, target: str, new_code: str):
        if target == "impl": self.impl = new_code
        elif target == "test": self.tests = new_code
        else: raise ValueError(f"Unknown target: {target}")

    def replace(self, target: str, old_code: str, new_code: str) -> str:
        try:
            err = self._validate_target(target)
            if err:
                return err
            current = self.get_code(target)
            old_norm = _normalize_for_match(old_code) if old_code else ""
            norm_cur = current.replace("\r\n", "\n").replace("\r", "\n")
            if not old_norm:
                return "Error: old_code cannot be empty."
            if old_norm not in norm_cur:
                return f"Error: old_code not found in {target}. Use exact string from file or use overwrite."
            if norm_cur.count(old_norm) > 1:
                return f"Error: old_code found {norm_cur.count(old_norm)} times in {target}. Please provide more context to be unique."
            result = norm_cur.replace(old_norm, new_code, 1)
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

class LibraryRetriever:
    def __init__(self, concepts_dir: str = "../../"):
        self.concepts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), concepts_dir))
        self.headless_url = os.getenv("HEADLESS_URL")
        if not self.headless_url:
             raise ValueError("HEADLESS_URL environment variable is required for LibraryRetriever.")
        
    def fetch_all_specs(self) -> Dict[str, str]:
        """Fetch all available concept specs from the library API."""
        # Normalize URL
        url = self.headless_url
        if url.endswith("/"): url = url[:-1]
        url = f"{url}/api/specs"
        
        try:
            import requests
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            
            # Check content type
            content_type = response.headers.get("Content-Type", "")
            
            if "application/json" in content_type:
                data = response.json()
                specs = {}
                if isinstance(data, list):
                    for item in data:
                        if "name" in item and "spec" in item:
                            specs[item["name"]] = item["spec"]
                elif isinstance(data, dict) and "specs" in data:
                        for item in data["specs"]:
                            if "name" in item and "spec" in item:
                                specs[item["name"]] = item["spec"]
                return specs
            else:
                # Handle text/plain format
                # --- CONCEPT: ConceptName ---
                # # Concept: ConceptName ...
                text = response.text
                specs = {}
                parts = text.split("--- CONCEPT: ")
                for part in parts:
                    if not part.strip(): continue
                    
                    # First line is ConceptName ---
                    lines = part.split("\n", 1)
                    if len(lines) < 2: continue
                    
                    header = lines[0].strip()
                    if header.endswith(" ---"):
                        name = header[:-4]
                        spec = lines[1]
                        specs[name] = spec
                return specs

        except Exception as e:
            raise RuntimeError(f"Failed to fetch library specs from API ({url}): {e}")

    def retrieve(self, concept_name: str) -> Dict[str, str]:
        """Retrieve a relevant reference concept from the library API."""
        import requests
        
        # Normalize URL
        url = self.headless_url
        if url.endswith("/"): url = url[:-1]
        
        try:
            # Attempt retrieval
            pull_url = f"{url}/api/pull/{concept_name}"
            response = requests.post(pull_url, timeout=10)
            response.raise_for_status()
            
            data = response.json()
            # If API returns spec, use it. If not, try to fetch it separately or fallback.
            spec = data.get("spec", "")
            
            if not spec:
                # Try fetching spec explicitly if not in pull response
                try:
                    spec_url = f"{url}/api/concepts/{concept_name}/spec"
                    spec_resp = requests.get(spec_url, timeout=5)
                    if spec_resp.status_code == 200:
                        spec = spec_resp.text
                except Exception:
                    pass

            return {
                "name": concept_name,
                "code": data.get("code", ""),
                "tests": data.get("tests", ""),
                "spec": spec
            }
            
        except requests.exceptions.HTTPError as e:
             if e.response.status_code == 404:
                 return {"name": "None", "code": "", "tests": "", "spec": ""}
             else:
                 raise RuntimeError(f"Library API retrieval failed for {concept_name}: {e}")
        except Exception as e:
            raise RuntimeError(f"Library API retrieval failed for {concept_name}: {e}")

class ImplementerModule(dspy.Module):
    def __init__(self):
        super().__init__()
        self.retriever = LibraryRetriever()
        
        # Load library specs for semantic retrieval context
        self.library_specs = self.retriever.fetch_all_specs()
        
        self.generator = dspy.ChainOfThought(GenerateImplementation)
        self.tester = dspy.ChainOfThought(GenerateTests)
        self.agent_step = dspy.ChainOfThought(AgentStep)
        self.selector = dspy.ChainOfThought(SelectReferenceConcepts)
        self.context = self._load_context()

    def _load_context(self) -> str:
        """Loads architectural context."""
        context_str = ""
        
        # Add library specs to context to guide generation
        if hasattr(self, 'library_specs') and self.library_specs:
            specs_list = "\n".join([f"Concept: {name}\n{spec}" for name, spec in self.library_specs.items()])
            context_str += f"--- AVAILABLE LIBRARY CONCEPTS (Use as Reference) ---\n{specs_list}\n\n"

        context_str += (
            "--- CRITICAL TESTING RULES ---\n"
            "1. Tests MUST import testDb from '@utils/database.ts'.\n"
            "2. NEVER define local testDb/MockDb/MockCollection implementations.\n"
            "3. NEVER use mongodb-memory-server or other in-memory Mongo substitutes.\n"
            "4. Always close the returned Mongo client in finally with await client.close().\n\n"
        )

        # Similar to Planning/ConceptDesigning logic
        try:
            current_dir = os.path.dirname(os.path.abspath(__file__))
            repo_root = os.path.abspath(os.path.join(current_dir, "../../../../"))
            base_path = os.path.join(repo_root, "design/background")
            
            # Expanded list of useful background documents
            files = [
                "implementing-concepts.md", 
                "testing-concepts.md", 
                "concept-specifications.md",
                "api-extraction-from-code.md" # Might be useful for understanding types/interfaces
            ]
            docs = []
            for f in files:
                p = os.path.join(base_path, f)
                if os.path.exists(p):
                    with open(p, "r", encoding="utf-8") as file:
                        docs.append(f"--- {f} ---\n{file.read()}\n")
            
            # Also load utils/database.ts and utils/types.ts into context
            utils_path = os.path.join(repo_root, "src/utils")
            utils_files = ["database.ts", "types.ts"]
            for f in utils_files:
                p = os.path.join(utils_path, f)
                if os.path.exists(p):
                    with open(p, "r", encoding="utf-8") as file:
                        docs.append(f"--- src/utils/{f} ---\n{file.read()}\n")

            return context_str + "\n".join(docs)
        except Exception:
            return context_str

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
                line_stripped.startswith("type ")):
                start_idx = i
                break
        
        if start_idx > 0:
            code = "\n".join(lines[start_idx:])
                
        return code.strip()

    def implement(self, spec: str, concept_name: str, existing_impl: Optional[str] = None, existing_tests: Optional[str] = None, feedback: Optional[str] = None) -> Dict[str, Any]:
        
        # 1. Select and Retrieve References
        references = []
        
        if hasattr(self, 'library_specs') and self.library_specs:
            available_names = list(self.library_specs.keys())
            specs_list = "\n".join([f"Concept: {name}\n{spec[:200]}..." for name, spec in self.library_specs.items()])
            
            print(f"Selecting reference for {concept_name}...", file=sys.stderr)
            
            max_selector_retries = 3
            selected_names = []
            
            for attempt in range(max_selector_retries):
                selection = self.selector(
                    concept_name=concept_name,
                    spec=spec,
                    available_library_concepts=specs_list
                )
                
                selected_names_str = (selection.selected_concepts or "").strip()
                print(f"Selected references (attempt {attempt + 1}): {selected_names_str} (Reason: {selection.reasoning})", file=sys.stderr)
                
                # Filter out "None" and validate against available concepts
                if selected_names_str and selected_names_str.lower() != "none":
                    selected_names = [n.strip() for n in selected_names_str.split(",")
                                      if n.strip() and n.strip().lower() != "none" and n.strip() in available_names]
                
                if selected_names:
                    break
                
                if attempt < max_selector_retries - 1:
                    print(f"Selector returned no valid concepts (attempt {attempt + 1}/{max_selector_retries}), retrying...", file=sys.stderr)
            
            if not selected_names:
                # Last resort: pick the first available library concept as a structural reference
                print(f"WARNING: Selector failed after {max_selector_retries} attempts. Using first available library concept as structural fallback.", file=sys.stderr)
                selected_names = [available_names[0]]
            
            for name in selected_names:
                ref = self.retriever.retrieve(name)
                if ref.get("code"):
                    references.append(ref)
        else:
             fallback = self.retriever.retrieve(concept_name)
             if fallback.get("code"):
                 references.append(fallback)

        # Build reference string
        ref_str = ""
        for i, ref in enumerate(references):
            ref_str += f"--- REFERENCE EXAMPLE {i+1}: {ref['name']} ---\n"
            ref_str += f"Code:\n{ref['code']}\n"
            ref_str += f"Tests:\n{ref['tests']}\n\n"
        
        if not ref_str:
            ref_str = "No reference examples available."
        
        # 2. Generate or Update Implementation
        if feedback:
            # If we have feedback, we treat it as a fix request on the existing implementation
            if not existing_impl or not existing_tests:
                # Fallback to generation if missing context, but feedback implies existence
                # We'll treat it as generation with feedback as context
                pass 
            else:
                # Go directly to fix loop with the feedback
                return self._fix_loop(spec, existing_impl, existing_tests, concept_name, feedback, max_iterations=15)

        # Initial Generation (retry on truncation)
        print(f"Generating implementation for {concept_name}...", file=sys.stderr)

        def _gen_impl():
            return self.generator(
                spec=spec,
                context=self.context,
                reference_examples=ref_str,
                previous_implementation=existing_impl
            )

        impl_pred = _retry_on_truncation(
            _gen_impl,
            lambda p: bool((p.typescript_code or "").strip()),
            max_attempts=3,
            label=f"Generating implementation for {concept_name}"
        )
        code = self._clean_code(impl_pred.typescript_code)

        # 3. Generate Tests (retry on truncation)
        print(f"Generating tests for {concept_name}...", file=sys.stderr)

        def _gen_tests():
            return self.tester(
                spec=spec,
                implementation_code=code,
                context=self.context,
                reference_examples=ref_str,
                previous_tests=existing_tests
            )

        test_pred = _retry_on_truncation(
            _gen_tests,
            lambda p: bool((p.test_code or "").strip()),
            max_attempts=3,
            label=f"Generating tests for {concept_name}"
        )
        tests = self._clean_code(test_pred.test_code)
        
        # 4. Loop
        return self._fix_loop(spec, code, tests, concept_name, max_iterations=15)

    def _fix_loop(self, spec: str, code: str, tests: str, concept_name: str, initial_error: Optional[str] = None, max_iterations: int = 15) -> Dict[str, Any]:
        editor = CodeEditor(code, tests)
        current_error = initial_error
        history = []
        
        # Initial validation if no error provided
        if not current_error:
            success, output = self._run_deno_tests(editor.impl, editor.tests, concept_name)
            if success:
                print("Initial tests passed!", file=sys.stderr)
                return {
                    "code": editor.impl,
                    "tests": editor.tests,
                    "status": "complete",
                    "iterations": 0
                }
            current_error = output
            print("Initial tests failed.", file=sys.stderr)

        for i in range(max_iterations):
            print(f"Agent Step {i+1}/{max_iterations}", file=sys.stderr)
            
            # Check for infrastructure errors that code changes cannot fix
            if current_error and ("MongoServerError" in current_error and "too long" in current_error):
                print(f"Aborting fix loop due to infrastructure error: {current_error.splitlines()[0]}", file=sys.stderr)
                return {
                    "code": editor.impl,
                    "tests": editor.tests,
                    "status": "error",
                    "error_log": f"Infrastructure Error: {current_error}",
                    "iterations": i
                }

            files_context = f"--- IMPLEMENTATION ---\n{editor.impl}\n\n--- TESTS ---\n{editor.tests}"
            
            pred = None
            step_retries = 3
            step_error = None
            for attempt in range(step_retries):
                try:
                    pred = self.agent_step(
                        spec=spec,
                        file_contents=files_context,
                        error_log=current_error or "Run validation",
                        previous_actions="\n".join(history) # FULL HISTORY
                    )
                    break
                except Exception as e:
                    step_error = str(e)
                    import time
                    time.sleep(1)
            
            if pred is None:
                print(f"Agent step failed repeatedly. Aborting fix loop. Last error: {step_error}", file=sys.stderr)
                return {
                    "code": editor.impl,
                    "tests": editor.tests,
                    "status": "error",
                    "error_log": f"Agent step failed: {step_error}",
                    "iterations": i
                }

            print(f"Thought: {pred.thought}", file=sys.stderr)
            
            tool_name = pred.tool_name
            try:
                tool_args = json.loads(pred.tool_args)
            except:
                tool_args = {}
                print(f"Error parsing args: {pred.tool_args}", file=sys.stderr)
            
            print(f"Action: {tool_name} {json.dumps(tool_args)}", file=sys.stderr)
            
            result_msg = ""
            
            if tool_name == "replace":
                result_msg = editor.replace(tool_args.get("target"), tool_args.get("old_code"), tool_args.get("new_code"))
            elif tool_name == "delete":
                result_msg = editor.delete(tool_args.get("target"), tool_args.get("code_to_delete"))
            elif tool_name == "insert_after":
                result_msg = editor.insert_after(tool_args.get("target"), tool_args.get("after_code"), tool_args.get("new_code"))
            elif tool_name == "overwrite":
                if "impl" in tool_args and "test" in tool_args:
                    editor.set_code("impl", tool_args["impl"])
                    editor.set_code("test", tool_args["test"])
                    result_msg = "Success: Both files overwritten."
                else:
                    result_msg = editor.overwrite(tool_args.get("target"), tool_args.get("new_code"))
            elif tool_name == "run_tests":
                pass # Handled after
            elif tool_name == "finish":
                pass # Handled after
            else:
                result_msg = f"Unknown tool: {tool_name}"
            
            print(f"Result: {result_msg[:200] if result_msg else 'Done'}...", file=sys.stderr)
            
            history.append(f"Thought: {pred.thought}\nAction: {tool_name} Args: {json.dumps(tool_args)}, Result: {result_msg}")
            
            # Re-validate
            success, output = self._run_deno_tests(editor.impl, editor.tests, concept_name)
            if success:
                print("Tests passed!", file=sys.stderr)
                return {
                    "code": editor.impl,
                    "tests": editor.tests,
                    "status": "complete",
                    "iterations": i + 1
                }
            current_error = output
            
            if current_error:
                 print(f"Test Output:\n{current_error[:2000]}...", file=sys.stderr)

        return {
            "code": editor.impl,
            "tests": editor.tests,
            "status": "error",
            "error_log": current_error,
            "iterations": max_iterations
        }

    def fixer(self, spec: str, current_impl: str, current_tests: str, error_log: str) -> Any:
        editor = CodeEditor(current_impl, current_tests)
        
        # Prepare context
        impl_preview = editor.impl[:10000] + "\n... (truncated)" if len(editor.impl) > 10000 else editor.impl
        test_preview = editor.tests[:10000] + "\n... (truncated)" if len(editor.tests) > 10000 else editor.tests
        files_context = f"--- IMPLEMENTATION ---\n{impl_preview}\n\n--- TESTS ---\n{test_preview}"
        
        # Predict
        pred = self.agent_step(
            spec=spec,
            file_contents=files_context,
            error_log=error_log,
            previous_actions="" # No history for single step fix
        )
        
        # Execute
        tool_name = pred.tool_name
        try:
            tool_args = json.loads(pred.tool_args)
        except:
            tool_args = {}
            
        result_msg = ""
        if tool_name == "replace":
            result_msg = editor.replace(tool_args.get("target"), tool_args.get("old_code"), tool_args.get("new_code"))
        elif tool_name == "delete":
            result_msg = editor.delete(tool_args.get("target"), tool_args.get("code_to_delete"))
        elif tool_name == "insert_after":
            result_msg = editor.insert_after(tool_args.get("target"), tool_args.get("after_code"), tool_args.get("new_code"))
        elif tool_name == "overwrite":
            if "impl" in tool_args and "test" in tool_args:
                editor.set_code("impl", tool_args["impl"])
                editor.set_code("test", tool_args["test"])
                result_msg = "Success: Both files overwritten."
            else:
                result_msg = editor.overwrite(tool_args.get("target"), tool_args.get("new_code"))
        
        return dspy.Prediction(
            fixed_impl=editor.impl,
            fixed_tests=editor.tests,
            explanation=f"Thought: {pred.thought}\nAction: {tool_name}\nResult: {result_msg}"
        )

    def _run_deno_check(self, impl_code: str, test_code: str, concept_name: str, target: str) -> tuple[bool, str]:
        with tempfile.TemporaryDirectory() as temp_dir:
            # Setup files
            impl_filename = f"{concept_name}Concept.ts"
            test_filename = f"{concept_name}Concept.test.ts"
            impl_path = os.path.join(temp_dir, impl_filename)
            test_path = os.path.join(temp_dir, test_filename)
            
            with open(impl_path, "w", encoding="utf-8") as f:
                f.write(impl_code)
            with open(test_path, "w", encoding="utf-8") as f:
                f.write(test_code)
                
            self._setup_temp_env(temp_dir)
            
            # Determine check target
            check_file = impl_filename if target == "impl" else test_filename
            
            try:
                # We use 'deno check' for compilation verification
                # We must ensure we ignore errors from @utils imports if they are not fully resolvable/types, 
                # but our _setup_temp_env creates stubs, so it should be fine.
                # However, strict type checking might complain about missing properties in stubs.
                # We want to catch syntax errors and major type mismatches.
                
                result = subprocess.run(
                    ["deno", "check", check_file],
                    cwd=temp_dir,
                    capture_output=True,
                    text=True,
                    timeout=30
                )
                
                output = result.stdout + "\n" + result.stderr
                return (result.returncode == 0, output)
            except Exception as e:
                return (False, str(e))

    def _run_deno_tests(self, impl_code: str, test_code: str, concept_name: str) -> tuple[bool, str]:
        strategy_ok, strategy_error = _validate_test_strategy(test_code)
        if not strategy_ok:
            return (False, strategy_error)

        with tempfile.TemporaryDirectory() as temp_dir:
            # Write files
            # Use concept name for file name to match imports, or standard Concept.ts and rewrite import
            # The generated tests likely import "./{ConceptName}Concept.ts"
            
            impl_filename = f"{concept_name}Concept.ts"
            test_filename = f"{concept_name}Concept.test.ts"
            
            impl_path = os.path.join(temp_dir, impl_filename)
            test_path = os.path.join(temp_dir, test_filename)
            
            with open(impl_path, "w", encoding="utf-8") as f:
                f.write(impl_code)
            with open(test_path, "w", encoding="utf-8") as f:
                f.write(test_code)
                
            # Create minimal deno.json and utils to satisfy imports
            self._setup_temp_env(temp_dir)
            
            # Run deno test
            try:
                # Use a unique DB name for generated tests to avoid wiping the main test DB
                # Fix: Ensure 'env' is defined by copying current environment variables
                env = os.environ.copy()
                # Use a fixed DB name for all generated tests to avoid creating many databases
                env["DB_NAME"] = "test_generated_concepts"

                # Run DB cleanup
                print("Running DB cleanup...", file=sys.stderr)
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
                } finally {
                    await client.close();
                }
                Deno.exit(0);
                """
                cleanup_path = os.path.join(temp_dir, "cleanup.ts")
                with open(cleanup_path, "w", encoding="utf-8") as f:
                    f.write(cleanup_script)
                
                # Run cleanup
                subprocess.run(
                    ["deno", "run", "--allow-net", "--allow-env", "--allow-sys", cleanup_path], 
                    cwd=temp_dir, 
                    env=env, 
                    capture_output=True, 
                    timeout=10
                )
                
                # We assume deno is in PATH
                result = subprocess.run(
                    ["deno", "test", "--allow-all", test_filename],
                    cwd=temp_dir,
                    capture_output=True,
                    text=True,
                    timeout=60, # Increased timeout
                    env=env
                )
                
                output = result.stdout + "\n" + result.stderr
                return (result.returncode == 0, output)
            except Exception as e:
                return (False, str(e))

    def _setup_temp_env(self, temp_dir: str):
        # We need to map @utils to the real project utils to avoid mocking drift
        # This assumes the project structure:
        # src/concepts/Implementing/dspy/implementer.py -> this file
        # src/utils/ -> real utils
        
        # Calculate real utils path
        current_dir = os.path.dirname(os.path.abspath(__file__))
        repo_root = os.path.abspath(os.path.join(current_dir, "../../../../"))
        real_utils_path = os.path.join(repo_root, "src/utils")
        
        # Ensure we use file:/// URI format for Deno imports on Windows to avoid "Unsupported scheme 'c'" errors
        # pathlib.Path.as_uri() handles this correctly across platforms
        from pathlib import Path
        real_utils_uri = Path(real_utils_path).as_uri()
        if not real_utils_uri.endswith("/"):
            real_utils_uri += "/"

        # Create deno.json with import map pointing to real utils
        deno_json = {
            "imports": {
                "@utils/": real_utils_uri,
                "npm:": "npm:",
                "jsr:": "jsr:"
            }
        }
        
        with open(os.path.join(temp_dir, "deno.json"), "w") as f:
            f.write(json.dumps(deno_json))

