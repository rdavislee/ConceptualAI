import dspy
import os
import json
import sys
import tempfile
import subprocess
import shutil
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv
from pydantic import BaseModel, Field

load_dotenv()

# Configure Gemini
api_key = os.getenv("GEMINI_API_KEY")
model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-pro")

if not api_key:
    print("Warning: GEMINI_API_KEY not found in environment variables.", file=sys.stderr)

# Fix model name for dspy/litellm compatibility
if not model_name.startswith("gemini/") and "gemini" in model_name:
    model_name = f"gemini/{model_name}"

lm = dspy.LM(model=model_name, api_key=api_key, max_tokens=64000)
dspy.settings.configure(lm=lm)

class GenerateImplementation(dspy.Signature):
    """Generate TypeScript implementation for a concept spec."""
    
    spec: str = dspy.InputField(desc="The full markdown specification of the concept.")
    context: str = dspy.InputField(desc="Architectural context and patterns.")
    reference_examples: str = dspy.InputField(desc="Reference implementation of a similar concept.")
    previous_implementation: Optional[str] = dspy.InputField(desc="Existing implementation code if updating.", default=None)
    
    typescript_code: str = dspy.OutputField(desc="The complete TypeScript class implementation.")

class GenerateTests(dspy.Signature):
    """Generate comprehensive Deno tests for a concept implementation."""
    
    spec: str = dspy.InputField(desc="The full markdown specification of the concept.")
    implementation_code: str = dspy.InputField(desc="The TypeScript implementation to test.")
    context: str = dspy.InputField(desc="Testing strategies and patterns.")
    reference_examples: str = dspy.InputField(desc="Reference tests of a similar concept.")
    previous_tests: Optional[str] = dspy.InputField(desc="Existing tests if updating.", default=None)
    
    test_code: str = dspy.OutputField(desc="The complete Deno test file.")

class AgentStep(dspy.Signature):
    """Analyze the error and code, and propose a tool action to fix it."""
    spec: str = dspy.InputField(desc="The concept specification.")
    file_contents: str = dspy.InputField(desc="Current contents of implementation and test files.") 
    error_log: str = dspy.InputField(desc="Test failure output or user feedback.")
    previous_actions: str = dspy.InputField(desc="History of what has been done.")
    
    thought: str = dspy.OutputField(desc="Reasoning about what to do next.")
    tool_name: str = dspy.OutputField(desc="One of: replace, delete, insert_after, overwrite, run_tests, finish")
    tool_args: str = dspy.OutputField(desc="JSON string of arguments. For overwrite, use {'target': 'impl'|'test', 'new_code': '...'}. Overwrite is preferred for large changes.")

class CodeEditor:
    def __init__(self, impl_code: str, test_code: str):
        self.impl = impl_code
        self.tests = test_code

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
            current = self.get_code(target)
            if old_code not in current:
                return f"Error: old_code not found in {target}."
            if current.count(old_code) > 1:
                return f"Error: old_code found {current.count(old_code)} times in {target}. Please provide more context to be unique."
            
            self.set_code(target, current.replace(old_code, new_code))
            return "Success: Code replaced."
        except Exception as e:
            return f"Error: {str(e)}"

    def delete(self, target: str, code_to_delete: str) -> str:
        try:
            current = self.get_code(target)
            if code_to_delete not in current:
                return f"Error: code_to_delete not found in {target}."
            if current.count(code_to_delete) > 1:
                return f"Error: code_to_delete found {current.count(code_to_delete)} times. Please provide unique context."
            
            self.set_code(target, current.replace(code_to_delete, ""))
            return "Success: Code deleted."
        except Exception as e:
            return f"Error: {str(e)}"

    def insert_after(self, target: str, after_code: str, new_code: str) -> str:
        try:
            current = self.get_code(target)
            if after_code not in current:
                return f"Error: after_code not found in {target}."
            if current.count(after_code) > 1:
                return f"Error: after_code found {current.count(after_code)} times. Please provide unique context."
            
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

class LibraryRetriever:
    def __init__(self, concepts_dir: str = "../"):
        self.concepts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), concepts_dir))
        self.headless_url = os.getenv("HEADLESS_URL")
        
    def retrieve(self, concept_name: str) -> Dict[str, str]:
        """Retrieve a relevant reference concept. 
        Uses the library API if available, otherwise falls back to local file scan (or hardcoded for now).
        """
        # 1. Try API if configured
        if self.headless_url:
            import requests
            try:
                # For this step, let's just pull 'UserAuthenticating' from the API to prove integration.
                # In a real system, we'd embed the spec and search against available specs.
                ref_concept = "UserAuthenticating"
                
                # Normalize URL
                url = self.headless_url
                if url.endswith("/"): url = url[:-1]
                url = f"{url}/api/pull/{ref_concept}"
                
                response = requests.post(url, timeout=5)
                if response.status_code == 200:
                    data = response.json()
                    return {
                        "name": ref_concept,
                        "code": data.get("code", ""),
                        "tests": data.get("tests", "")
                    }
            except Exception as e:
                print(f"Warning: Library API retrieval failed: {e}", file=sys.stderr)

        # 2. Fallback to local
        ref_concept = "UserAuthenticating"
        ref_path = os.path.join(self.concepts_dir, ref_concept)
        
        try:
            # Try finding the concept file. The name usually matches the folder + "Concept.ts"
            # But folder might be just "UserAuthenticating" and file "UserAuthenticatingConcept.ts"
            code_path = os.path.join(ref_path, f"{ref_concept}Concept.ts")
            test_path = os.path.join(ref_path, f"{ref_concept}Concept.test.ts")
            
            if os.path.exists(code_path) and os.path.exists(test_path):
                with open(code_path, "r", encoding="utf-8") as f:
                    code = f.read()
                with open(test_path, "r", encoding="utf-8") as f:
                    tests = f.read()
                return {
                    "name": ref_concept,
                    "code": code,
                    "tests": tests
                }
        except Exception as e:
            print(f"Warning: Failed to load reference concept {ref_concept}: {e}", file=sys.stderr)
            
        return {"name": "None", "code": "", "tests": ""}

class ImplementerModule(dspy.Module):
    def __init__(self):
        super().__init__()
        self.retriever = LibraryRetriever()
        self.generator = dspy.ChainOfThought(GenerateImplementation)
        self.tester = dspy.ChainOfThought(GenerateTests)
        self.agent_step = dspy.ChainOfThought(AgentStep)
        self.context = self._load_context()

    def _load_context(self) -> str:
        """Loads architectural context."""
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

            return "\n".join(docs)
        except Exception:
            return ""

    # Remove markdown code block fences if present
    def _clean_code(self, code: str) -> str:
        if not code: return ""
        code = code.strip()
        if code.startswith("```typescript"):
            code = code[13:]
        elif code.startswith("```ts"):
            code = code[5:]
        elif code.startswith("```"):
            code = code[3:]
        
        if code.endswith("```"):
            code = code[:-3]
        return code.strip()

    def implement(self, spec: str, concept_name: str, existing_impl: Optional[str] = None, existing_tests: Optional[str] = None, feedback: Optional[str] = None) -> Dict[str, Any]:
        
        # 1. Retrieve Reference
        reference = self.retriever.retrieve(concept_name)
        ref_str = f"Example Concept: {reference['name']}\nCode:\n{reference['code']}\nTests:\n{reference['tests']}"
        
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

        # Initial Generation
        print(f"Generating implementation for {concept_name}...")
        impl_pred = self.generator(
            spec=spec,
            context=self.context,
            reference_examples=ref_str,
            previous_implementation=existing_impl
        )
        code = self._clean_code(impl_pred.typescript_code)
        
        # 3. Generate Tests
        print(f"Generating tests for {concept_name}...")
        test_pred = self.tester(
            spec=spec,
            implementation_code=code,
            context=self.context,
            reference_examples=ref_str,
            previous_tests=existing_tests
        )
        tests = self._clean_code(test_pred.test_code)
        
        # 4. Loop
        return self._fix_loop(spec, code, tests, concept_name, max_iterations=15)

    def _fix_loop(self, spec: str, code: str, tests: str, concept_name: str, initial_error: Optional[str] = None, max_iterations: int = 15) -> Dict[str, Any]:
        
        editor = CodeEditor(code, tests)
        current_error = initial_error
        
        # Initial test run if no error yet
        if not current_error:
            success, output = self._run_deno_tests(editor.impl, editor.tests, concept_name)
            if success:
                print("Initial tests passed!")
                return {
                    "code": editor.impl,
                    "tests": editor.tests,
                    "status": "complete",
                    "iterations": 0
                }
            current_error = output
            print("Initial tests failed.")

        history = []
        
        for i in range(max_iterations):
            print(f"Agent Step {i+1}/{max_iterations}")
            
            # Predict next action
            # We truncate file contents to avoid excessive context, but allow agent to read full file
            impl_preview = editor.impl[:10000] + "\n... (use read_file to see more)" if len(editor.impl) > 10000 else editor.impl
            test_preview = editor.tests[:10000] + "\n... (use read_file to see more)" if len(editor.tests) > 10000 else editor.tests
            
            files_context = f"--- IMPLEMENTATION (preview) ---\n{impl_preview}\n\n--- TESTS (preview) ---\n{test_preview}"
            
            pred = self.agent_step(
                spec=spec,
                file_contents=files_context,
                error_log=current_error,
                previous_actions="\n".join(history[-5:]) # Keep last 5 actions context
            )
            
            tool_name = pred.tool_name
            try:
                tool_args = json.loads(pred.tool_args)
            except:
                # Fallback if arguments aren't valid JSON, sometimes models make mistakes
                # Try to parse manually or just error
                tool_args = {}
                print(f"Error parsing args: {pred.tool_args}")

            print(f"Thought: {pred.thought}")
            print(f"Action: {tool_name} {tool_args}")
            
            # Execute Tool
            result = ""
            if tool_name == "replace":
                result = editor.replace(tool_args.get("target"), tool_args.get("old_code"), tool_args.get("new_code"))
                
            elif tool_name == "delete":
                result = editor.delete(tool_args.get("target"), tool_args.get("code_to_delete"))
                
            elif tool_name == "insert_after":
                result = editor.insert_after(tool_args.get("target"), tool_args.get("after_code"), tool_args.get("new_code"))
                
            elif tool_name == "overwrite":
                result = editor.overwrite(tool_args.get("target"), tool_args.get("new_code"))
                
            elif tool_name == "run_tests":
                success, output = self._run_deno_tests(editor.impl, editor.tests, concept_name)
                if success:
                    print("Tests passed!")
                    return {
                        "code": editor.impl,
                        "tests": editor.tests,
                        "status": "complete",
                        "iterations": i + 1
                    }
                else:
                    current_error = output
                    result = f"Tests failed:\n{output[:1000]}..." # Truncate output for observation
                    
            elif tool_name == "finish":
                # Check one last time
                success, output = self._run_deno_tests(editor.impl, editor.tests, concept_name)
                if success:
                    return {
                        "code": editor.impl,
                        "tests": editor.tests,
                        "status": "complete",
                        "iterations": i + 1
                    }
                else:
                    current_error = output
                    result = "Cannot finish, tests still failing."
            
            else:
                result = f"Unknown tool: {tool_name}"
            
            print(f"Result: {result[:200] if result else 'Done'}...")
            
            # Truncate result in history if it's too long, especially for replace/overwrite arguments in tool_args which are already in history
            # But the result of read_file might be long and important.
            # Truncate previous_actions context for the next step to avoid massive prompt growth.
            
            history.append(f"Action: {tool_name}, Args: {json.dumps(tool_args)[:1000]}..., Result: {result[:1000]}")
            
        return {
            "code": editor.impl,
            "tests": editor.tests,
            "status": "error",
            "error_log": current_error,
            "iterations": max_iterations
        }

    def _run_deno_tests(self, impl_code: str, test_code: str, concept_name: str) -> tuple[bool, str]:
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
                # We assume deno is in PATH
                result = subprocess.run(
                    ["deno", "test", "--allow-all", test_filename],
                    cwd=temp_dir,
                    capture_output=True,
                    text=True,
                    timeout=60 # Increased timeout
                )
                
                output = result.stdout + "\n" + result.stderr
                return (result.returncode == 0, output)
            except Exception as e:
                return (False, str(e))

    def _setup_temp_env(self, temp_dir: str):
        # Create utils/types.ts and utils/database.ts mocks if needed
        # This mirrors what ImplementingConcept.ts does
        utils_dir = os.path.join(temp_dir, "utils")
        os.makedirs(utils_dir, exist_ok=True)
        
        with open(os.path.join(utils_dir, "types.ts"), "w") as f:
            f.write("export type ID = string;\nexport type Empty = Record<string, never>;\n")
            
        # We might need a mock database or ensure imports work. 
        # The concepts usually import from @utils/database.ts. 
        # We need a deno.json map.
        deno_json = {
            "imports": {
                "@utils/": "./utils/",
                "npm:": "npm:",
                "jsr:": "jsr:"
            }
        }
        with open(os.path.join(temp_dir, "deno.json"), "w") as f:
            f.write(json.dumps(deno_json))
            
        # Mock database.ts if tests rely on it (usually they mock it or use a test helper)
        with open(os.path.join(utils_dir, "database.ts"), "w") as f:
            f.write("""
            export async function testDb() { 
                // Simple mock for compilation check
                return [
                    { collection: () => ({ 
                        createIndex: () => {}, 
                        findOne: () => null, 
                        insertOne: () => ({ insertedId: "1" }),
                        updateOne: () => ({ matchedCount: 1 }),
                        deleteOne: () => ({ deletedCount: 1 })
                    }) }, 
                    { close: () => {} }
                ]; 
            }
            export function freshID() { return "id_" + Math.random(); }
            """)
