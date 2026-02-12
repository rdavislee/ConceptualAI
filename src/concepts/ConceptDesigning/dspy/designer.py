import dspy
import os
import json
import sys
import time
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv
from pydantic import BaseModel, Field

load_dotenv()

# Configure Gemini
api_key = os.getenv("GEMINI_API_KEY")
model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-pro")

if not api_key:
    # Print to stderr so it doesn't mess up JSON stdout
    print("Warning: GEMINI_API_KEY not found in environment variables.", file=sys.stderr)

# Fix model name for dspy/litellm compatibility
if not model_name.startswith("gemini/") and "gemini" in model_name:
    model_name = f"gemini/{model_name}"

lm = dspy.LM(model=model_name, api_key=api_key, max_tokens=64000, cache=False, temperature=0.5)
dspy.settings.configure(lm=lm)

class LibraryPull(BaseModel):
    libraryName: str = Field(description="Name of the concept in the library (e.g., 'Liking')")
    plan_justification: str = Field(description="Which specific entity or flow in the plan requires this concept. Must cite a concrete plan item.")

class CustomConcept(BaseModel):
    name: str = Field(description="Name of the new concept")
    plan_justification: str = Field(description="Which specific entity or flow in the plan requires this concept. Must cite a concrete plan item — not a general assumption.")
    spec: str = Field(description="Full markdown specification of the concept including purpose, principle, state, actions, and queries.")

class DesignOutput(BaseModel):
    library_pulls: List[LibraryPull]
    custom_concepts: List[CustomConcept]

class ConceptDesigningSignature(dspy.Signature):
    """
    Decompose a plan into concepts: pull from library when possible, create custom only when necessary.
    
    STEP 1 — EXTRACT WHAT THE PLAN NEEDS:
    List every entity and user flow from the plan. These are the ONLY things you are building concepts for.
    
    STEP 2 — MATCH TO LIBRARY:
    For each entity/flow from Step 1, check available_concepts for a match. Prefer library pulls.
    - Only pull a library concept if it maps to a SPECIFIC entity or flow you listed in Step 1.
      If no plan item needs it, do NOT pull it — even if it "seems useful."
    - One library concept can serve multiple purposes (e.g. one Commenting for Posts and Stories).
    - Multi-user apps MUST include Authenticating and Sessioning.
    - NEVER include Requesting/API/Gateway — added automatically.
    - NEVER duplicate a library concept as a custom concept.
    
    STEP 3 — CUSTOM CONCEPTS (only for genuine gaps):
    Before creating ANY custom concept, answer TWO questions:
      Q1: "Which specific entity or flow in the plan requires this?"
          If you cannot point to a concrete plan item, DO NOT create it.
      Q2: "Can existing library concepts already cover this?"
          If yes, DO NOT create it.
    
    Write custom specs in the format from context_docs (purpose, principle, state in SSF, actions with requires/effects, queries).
    Include FULL CRUD actions per entity and inverses for reversible actions.
    """

    plan: str = dspy.InputField(desc="The JSON plan describing the application's entities, flows, and requirements.")
    available_concepts: str = dspy.InputField(desc="Markdown catalog of available library concepts and their specs.")
    context_docs: str = dspy.InputField(desc="Reference documentation for Concept Design specifications.")
    
    plan_needs: str = dspy.OutputField(desc="STEP 1 OUTPUT: List every entity and user flow from the plan. Be exhaustive but ONLY list what the plan explicitly describes. This is the ONLY set of things you are building concepts for.")
    output: DesignOutput = dspy.OutputField(desc="STEPS 2-3 OUTPUT: The design. Every concept here (library or custom) must map to something in your plan_needs list above.")

class ModifyDesignSignature(dspy.Signature):
    """
    Update an existing software design based on feedback and a potentially revised plan.
    
    You are an expert software architect using the Concept Design methodology.
    
    INSTRUCTIONS:
    1. Review the 'current_design' to see existing library pulls and custom concepts.
    2. Analyze the 'plan' (which may have been updated) and the 'feedback'.
    3. Modify the design to address the feedback and align with the plan.
    4. You can add/remove library pulls or add/remove/update custom concepts.
    5. Follow the same strict rules as creating a new design (no duplicates, SSF state, etc.).
    6. Verify custom concept action completeness: full CRUD per entity, add/remove for memberships, inverses for reversible actions.
    """
    
    plan: str = dspy.InputField(desc="The updated JSON plan.")
    current_design: str = dspy.InputField(desc="The current JSON design (library pulls and custom concepts).")
    feedback: str = dspy.InputField(desc="User feedback requesting changes.")
    available_concepts: str = dspy.InputField(desc="Markdown catalog of available library concepts.")
    context_docs: str = dspy.InputField(desc="Reference documentation.")
    
    output: DesignOutput = dspy.OutputField(desc="The modified design.")

class ConceptDesigner:
    def __init__(self):
        self.context = self._load_context()
        self.generator = dspy.ChainOfThought(ConceptDesigningSignature)
        self.modifier = dspy.ChainOfThought(ModifyDesignSignature)

    def _load_context(self) -> str:
        """Loads relevant background documentation."""
        docs = []
        try:
            # We assume the script is run from src/concepts/ConceptDesigning/dspy/
            current_dir = os.path.dirname(os.path.abspath(__file__))
            repo_root = os.path.abspath(os.path.join(current_dir, "../../../../"))
            base_path = os.path.join(repo_root, "design/background")
            
            files_to_read = [
                "concept-specifications.md",
                "concept-design-overview.md"
            ]
            
            for f in files_to_read:
                path = os.path.join(base_path, f)
                if os.path.exists(path):
                    with open(path, "r", encoding="utf-8") as file:
                        docs.append(f"--- {f} ---\n{file.read()}\n")
                else:
                    # Try relative path if running from root
                    # This fallback helps if directory structure assumption is slightly off during testing
                    alt_path = os.path.join("design/background", f)
                    if os.path.exists(alt_path):
                         with open(alt_path, "r", encoding="utf-8") as file:
                            docs.append(f"--- {f} ---\n{file.read()}\n")
                    else:
                        print(f"Warning: Context file not found at {path} or {alt_path}", file=sys.stderr)
                    
        except Exception as e:
            print(f"Error loading context: {e}", file=sys.stderr)
            return ""
            
        return "\n".join(docs)

    def _call_with_retry(self, func, is_valid=None, **kwargs):
        """Calls a DSPy predictor with retry logic. Retries on exception or invalid/truncated output (no token changes)."""
        max_retries = 3
        last_exception = None
        result = None

        for attempt in range(max_retries):
            try:
                result = func(**kwargs)
                if is_valid is None or is_valid(result):
                    return result
                if attempt < max_retries - 1:
                    print(f"Warning: Output invalid/truncated (attempt {attempt + 1}/{max_retries}), retrying...", file=sys.stderr)
                    time.sleep(2)
            except Exception as e:
                last_exception = e
                result = None
                print(f"Warning: DSPy call failed (attempt {attempt + 1}/{max_retries}): {e}", file=sys.stderr)
                if attempt < max_retries - 1:
                    time.sleep(2)

        if last_exception:
            raise last_exception
        return result

    def generate_design(self, plan: str, available_concepts: str) -> Dict[str, Any]:
        
        def _valid_design(p):
            return hasattr(p, "output") and p.output is not None

        try:
            prediction = self._call_with_retry(
                self.generator,
                is_valid=_valid_design,
                plan=plan,
                available_concepts=available_concepts,
                context_docs=self.context
            )
        except Exception as e:
             return {
                "libraryPulls": [],
                "customConcepts": [],
                "error": f"Failed to generate design after retries: {str(e)}"
            }
        
        # dspy with Pydantic output returns an object where .output is the Pydantic model
        if hasattr(prediction, 'output') and prediction.output:
            data = prediction.output.model_dump()
            return {
                "libraryPulls": data.get("library_pulls", []),
                "customConcepts": data.get("custom_concepts", [])
            }
        
        # Fallback if structure parsing failed (should be caught by dspy retry usually)
        return {
            "libraryPulls": [],
            "customConcepts": [],
            "error": "Failed to generate valid design structure"
        }

    def modify_design(self, plan: str, current_design: str, feedback: str, available_concepts: str) -> Dict[str, Any]:
        def _valid_modify(p):
            return hasattr(p, "output") and p.output is not None

        try:
            prediction = self._call_with_retry(
                self.modifier,
                is_valid=_valid_modify,
                plan=plan,
                current_design=current_design,
                feedback=feedback,
                available_concepts=available_concepts,
                context_docs=self.context
            )
        except Exception as e:
             return {
                "libraryPulls": [],
                "customConcepts": [],
                "error": f"Failed to modify design after retries: {str(e)}"
            }
        
        # dspy with Pydantic output returns an object where .output is the Pydantic model
        if hasattr(prediction, 'output') and prediction.output:
            data = prediction.output.model_dump()
            return {
                "libraryPulls": data.get("library_pulls", []),
                "customConcepts": data.get("custom_concepts", [])
            }
        
        return {
            "libraryPulls": [],
            "customConcepts": [],
            "error": "Failed to modify design"
        }
