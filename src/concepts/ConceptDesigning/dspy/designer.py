import dspy
import os
import json
import sys
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

lm = dspy.LM(model=model_name, api_key=api_key, max_tokens=8192)
dspy.settings.configure(lm=lm)

class LibraryPull(BaseModel):
    libraryName: str = Field(description="Name of the concept in the library (e.g., 'Liking')")
    instanceName: str = Field(description="Name of this instance in the project (e.g., 'PostLiking')")
    bindings: Dict[str, str] = Field(description="Mapping of generic parameters to project types (e.g., {'Item': 'Post', 'User': 'User'})")

class CustomConcept(BaseModel):
    name: str = Field(description="Name of the new concept")
    spec: str = Field(description="Full markdown specification of the concept including purpose, principle, state, actions, and queries.")

class DesignOutput(BaseModel):
    library_pulls: List[LibraryPull]
    custom_concepts: List[CustomConcept]

class ConceptDesigningSignature(dspy.Signature):
    """
    Select library concepts and create specs for custom concepts based on a project plan.
    
    You are an expert software architect using the Concept Design methodology.
    Your goal is to decompose the application described in the 'plan' into a set of independent, modular 'concepts'.
    
    CONCEPTS:
    - A concept is a self-contained unit of functionality (e.g., Auth, Upvote, Commenting).
    - Concepts are independent and do not depend on each other.
    - Concepts use generic parameters (e.g., Comment[Author, Item]) to be reusable.
    
    INSTRUCTIONS:
    1. Read the 'context_docs' to understand the rigorous format for concept specifications.
    2. Analyze the 'plan' to understand the required functionality.
    3. Check 'available_concepts' (the library) for reusable concepts.
    4. If a library concept fits, use it! You can instantiate it multiple times (e.g., Liking for Posts, Liking for Comments).
       - Determine the 'instanceName' (e.g., PostLiking).
       - Map generic parameters in 'bindings' (e.g., { "Item": "Post", "User": "User" }).
    5. If no library concept fits, create a 'customConcept'.
       - Write a FULL concept specification in Markdown.
       - You MUST follow the standard format defined in 'context_docs': purpose, principle, state, actions, queries.
       - Ensure state is described using the SSF (Sets of State) format.
       - Ensure actions have requires/effects.
    """

    plan: str = dspy.InputField(desc="The JSON plan describing the application's entities, flows, and requirements.")
    available_concepts: str = dspy.InputField(desc="Markdown catalog of available library concepts and their specs.")
    context_docs: str = dspy.InputField(desc="Reference documentation for Concept Design specifications.")
    
    output: DesignOutput = dspy.OutputField(desc="The design containing library pulls and custom concept specifications.")

class ConceptDesigner:
    def __init__(self):
        self.context = self._load_context()
        self.generator = dspy.ChainOfThought(ConceptDesigningSignature)

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

    def generate_design(self, plan: str, available_concepts: str) -> Dict[str, Any]:
        
        prediction = self.generator(
            plan=plan,
            available_concepts=available_concepts,
            context_docs=self.context
        )
        
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
