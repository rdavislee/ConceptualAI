import dspy
import os
import json
import sys
import time
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv

load_dotenv()

# Configure Gemini
api_key = os.getenv("GEMINI_API_KEY")
model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-pro")

if not api_key:
    print("Warning: GEMINI_API_KEY not found in environment variables.")

# Ensure model name is correctly prefixed for litellm
if not model_name.startswith("gemini/") and "gemini" in model_name:
    model_name = f"gemini/{model_name}"

    lm = dspy.LM(model=model_name, api_key=api_key, cache=False, temperature=0.5, max_tokens=24000)
dspy.settings.configure(lm=lm)

from pydantic import BaseModel, Field

class Entity(BaseModel):
    name: str = Field(description="Entity name (e.g. 'Post', 'Comment', 'Profile')")
    description: str = Field(description="What this entity represents and who owns it")
    fields: List[str] = Field(description="All fields including ownership, timestamps, relational refs, and status")

class UserFlow(BaseModel):
    name: str = Field(description="Flow name (e.g. 'Create Post', 'Edit Profile', 'Unlike Post')")
    description: str = Field(description="What the user is trying to accomplish")
    steps: List[str] = Field(description="Ordered steps including where the user starts and where they end up after")

class Page(BaseModel):
    name: str = Field(description="Page name (e.g. 'Feed', 'My Profile', 'Edit Post', 'Login')")
    description: str = Field(description="Purpose of the page and whether it requires authentication")
    elements: List[str] = Field(description="UI elements: forms, lists, buttons, cards, nav items, empty states")

class PlanOutput(BaseModel):
    """The structured plan output."""
    summary: str = Field(description="App overview including landing page behavior and primary navigation structure")
    entities: List[Entity]
    user_flows: List[UserFlow]
    pages: List[Page]

class PlanningSignature(dspy.Signature):
    """Analyze app description and produce a detailed feature plan.
    
    The output MUST be a JSON object with keys: "needs_clarification", "questions", and "plan".
    If the description is vague, set "needs_clarification" to true and list "questions".
    If the description is clear, set "needs_clarification" to false, "questions" to [], and provide the "plan".
    
    The plan should be agnostic to specific 'Concept' names but structured enough for an architect to infer them.
    Focus on Entities (Data), User Flows (Actions), and Pages (UI).
    
    === ENTITY COMPLETENESS ===
    For each entity, list ALL meaningful fields including:
    - Ownership: who created it (e.g. author, owner, creator)
    - Timestamps: createdAt, updatedAt
    - Relational fields: references to other entities (e.g. a Comment references a Post)
    - Status/state fields if applicable (e.g. draft/published, active/archived)
    
    === USER FLOW COMPLETENESS ===
    Flows are the actions a user performs. Ensure FULL LIFECYCLE coverage:
    
    1. CRUD FOR EVERY ENTITY: If a user can create something, they must also be able to edit and delete it.
       Do NOT generate "Create Post" without also generating "Edit Post" and "Delete Post".
    
    2. REVERSIBLE ACTIONS: Every toggle action needs its inverse.
       Follow -> Unfollow. Like -> Unlike. Save -> Unsave. Join -> Leave. Block -> Unblock.
       ALWAYS generate both directions.
    
    3. POST-ACTION DESTINATIONS: Each flow's steps should describe where the user ends up afterward.
       "After creating a post, the user is redirected to the post detail page."
       "After deleting their account, the user is redirected to the login page."
    
    4. ONBOARDING & MANDATORY SETUP: Cross-reference Registration against your entities.
       If an entity is REQUIRED for the app (e.g. Profile) but NOT created during registration itself,
       the registration flow MUST include a setup step BEFORE the user reaches the main app.
       BAD:  "Register -> Home Feed" (Profile entity exists but never created)
       GOOD: "Register -> Create Profile -> Home Feed"
    
    === PAGE COMPLETENESS ===
    Generate ALL applicable page types:
    
    1. AUTH PAGES: Login, Register, onboarding steps (e.g. "Create Profile" after registration). Do not skip these.
    2. EXPLORATION PAGES: Feeds, search, public profiles, detail views. For every list, consider if items need a detail page.
    3. SELF/OWNERSHIP PAGES: For EVERY entity a user owns, a page to view/manage their own instances (My Profile, My Posts, etc.). Commonly missed -- do NOT skip.
    4. CREATION/EDIT FORMS: Dedicated pages for creating or editing entities (Create Post, Edit Profile, New Message).
    5. NOTIFICATION/ACTIVITY: If the app has social interactions, users need a page to see activity directed at them.
    6. SETTINGS: Account settings, preferences, danger zone (delete account).
    
    Do NOT conflate public views with self-views -- viewing someone else's profile vs your own are different pages.

    === DATA ACCESSIBILITY (CRITICAL) ===
    Every core piece of app data required by the plan MUST be reachable through explicit user flows and pages.
    If users need to discover other users/content/entities, you MUST include a discovery path (search, browse, directory, recommendations, or invites).
    Never assume data is "implicitly accessible" without a concrete UI route.
    Example: if users can friend each other, include how a user finds another user (e.g., Search Profiles page + flow).
    If an entity has no realistic way to be found/viewed in the UI, the plan is incomplete.
    
    === NAVIGATION & ENTRY POINTS ===
    Describe in the summary: landing page (logged-out vs logged-in), primary nav items, and which pages are public.
    
    === FINAL VERIFICATION ===
    Walk through each entity:
    - Create it? -> creation flow + form page exist?
    - Own instances? -> self-view page exists?
    - Edit it? -> edit flow + edit page exist?
    - Delete it? -> delete flow exists?
    - View others' version? -> public detail page exists?
    - List view? -> detail view for items exists?
    - Toggle actions? -> both directions exist?
    Cross-reference: entity required before app is usable? -> registration flow includes its creation?
    """
    
    app_description: str = dspy.InputField(desc="The user's description of the application.")
    context_docs: str = dspy.InputField(desc="Background documentation on the concept architecture style.")
    clarification_history: str = dspy.InputField(desc="Previous Q&A pairs, if any. Use this to refine the plan.")
    
    needs_clarification: bool = dspy.OutputField(desc="True if the core purpose is too ambiguous to plan.")
    questions: List[str] = dspy.OutputField(desc="Clarifying questions if needs_clarification is True. Empty otherwise.")
    plan: Optional[PlanOutput] = dspy.OutputField(desc="The structured plan. Null/Empty if needs_clarification is True.")

class ModifyPlanSignature(dspy.Signature):
    """Modify an existing plan based on user feedback.
    
    Apply the requested changes while preserving the rest of the plan.
    After modifying, verify page completeness: for every entity a user can own,
    ensure both a public view page AND a self/ownership page exist (e.g. 'User Profile' vs 'My Profile').
    Also verify data accessibility: every required entity/data surface remains reachable via concrete user flows/pages,
    including discovery/search flows when users must find other users/content to complete key actions.
    Do not remove pages unless the user explicitly asks.
    """
    
    current_plan: str = dspy.InputField(desc="The existing JSON plan.")
    feedback: str = dspy.InputField(desc="User feedback requesting changes.")
    context_docs: str = dspy.InputField(desc="Background documentation on the concept architecture style.")
    
    modified_plan: PlanOutput = dspy.OutputField(desc="The updated structured plan.")

class Planner:
    def __init__(self):
        self.context = self._load_context()
        self.predictor = dspy.ChainOfThought(PlanningSignature)
        self.modifier = dspy.ChainOfThought(ModifyPlanSignature)

    def _load_context(self) -> str:
        """Loads relevant background documentation to prime the planner."""
        docs = []
        try:
            # We assume the script is run from src/concepts/Planning/dspy/
            # and the repo root is ../../../../
            # However, when running with python src/concepts/Planning/dspy/main.py from root,
            # we need to adjust or use absolute paths.
            
            # Using absolute path relative to this file
            current_dir = os.path.dirname(os.path.abspath(__file__))
            # We are in src/concepts/Planning/dspy/
            # We want to go to design/background/
            # So ../../../../design/background
            # BUT dspy/ is 1, Planning/ is 2, concepts/ is 3, src/ is 4.
            # So ../../../../ gets to root.
            
            repo_root = os.path.abspath(os.path.join(current_dir, "../../../../"))
            base_path = os.path.join(repo_root, "design/background")
            
            files_to_read = [
                "implementing-concepts.md",
                "implementing-synchronizations.md",
                "concept-design-overview.md"
            ]
            
            for f in files_to_read:
                path = os.path.join(base_path, f)
                if os.path.exists(path):
                    with open(path, "r", encoding="utf-8") as file:
                        docs.append(f"--- {f} ---\n{file.read()}\n")
                else:
                    print(f"Warning: Context file not found at {path}")
                    
        except Exception as e:
            print(f"Error loading context: {e}")
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

    def generate_plan(self, description: str, clarification_history: List[Dict[str, str]] = None) -> Dict[str, Any]:
        """Generates a plan or questions based on description and optional history."""
        
        history_str = ""
        if clarification_history:
            history_str = json.dumps(clarification_history, indent=2)
            
        def _valid_plan(p):
            if p is None:
                return False
            needs_clar = getattr(p, "needs_clarification", False)
            if needs_clar:
                return bool(getattr(p, "questions", None))
            plan = getattr(p, "plan", None)
            return plan is not None and (hasattr(plan, "entities") or hasattr(plan, "model_dump") or isinstance(plan, dict))

        try:
            prediction = self._call_with_retry(
                self.predictor,
                is_valid=_valid_plan,
                app_description=description,
                context_docs=self.context,
                clarification_history=history_str
            )
        except Exception as e:
             return {
                "status": "error",
                "plan": None,
                "questions": None,
                "error": f"Failed after retries: {str(e)}"
            }
        
        result = {
            "status": "complete",
            "plan": None,
            "questions": None
        }

        if prediction.needs_clarification:
            result["status"] = "needs_clarification"
            result["questions"] = prediction.questions
        else:
            # PlanOutput is a Pydantic model, so we dump it to dict
            # dspy.OutputField with Pydantic model returns the model instance
            if prediction.plan:
                # Handle potential case where dspy returns dict instead of model instance
                # though with dspy.BaseModel it should be an object
                if hasattr(prediction.plan, "model_dump"):
                    result["plan"] = prediction.plan.model_dump()
                elif hasattr(prediction.plan, "dict"):
                    result["plan"] = prediction.plan.dict()
                else:
                     result["plan"] = prediction.plan
            else:
                 # Fallback if plan is missing but needs_clarification is false (shouldn't happen with CoT)
                 result["status"] = "error"
                 # Add debug info
                 print(f"DEBUG: Prediction missing plan and needs_clarification=False. Prediction: {prediction}")
                 
        return result

    def clarify_plan(self, description: str, answers: Dict[str, str], previous_clarifications: List[Dict[str, str]]) -> Dict[str, Any]:
        """Refines a plan based on new answers."""
        
        # Merge new answers into history
        # We need to pair them with the questions.
        # Since the API receives just the answers map and previous history (which has Q&A),
        # we append the new ones.
        # NOTE: The caller (PlanningConcept.ts) constructs the full history list including new answers
        # before calling this, or passes them separately.
        # Based on my main.py draft, we receive `answers` and `previous_clarifications`.
        # The planner.py logic above just takes a list of history.
        
        # Let's combine them for the prompt
        full_history = previous_clarifications.copy() if previous_clarifications else []
        for q, a in answers.items():
            full_history.append({"question": q, "answer": a})
            
        return self.generate_plan(description, clarification_history=full_history)

    def modify_plan(self, current_plan: Dict[str, Any], feedback: str) -> Dict[str, Any]:
        """Modifies an existing plan based on feedback."""
        
        plan_str = json.dumps(current_plan, indent=2)
        
        def _valid_modify(p):
            return p.modified_plan is not None

        try:
            prediction = self._call_with_retry(
                self.modifier,
                is_valid=_valid_modify,
                current_plan=plan_str,
                feedback=feedback,
                context_docs=self.context
            )
        except Exception as e:
             return {
                "status": "error",
                "plan": None,
                "error": f"Failed after retries: {str(e)}"
            }
        
        result = {
            "status": "complete",
            "plan": None
        }
        
        if prediction.modified_plan:
            if hasattr(prediction.modified_plan, "model_dump"):
                result["plan"] = prediction.modified_plan.model_dump()
            elif hasattr(prediction.modified_plan, "dict"):
                result["plan"] = prediction.modified_plan.dict()
            else:
                result["plan"] = prediction.modified_plan
        else:
            result["status"] = "error"
            print(f"DEBUG: Modification failed to return a plan. Prediction: {prediction}")
            
        return result
