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

lm = dspy.LM(model=model_name, api_key=api_key, max_tokens=24000, cache=False, temperature=0.5)
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
    List every entity and user flow from the plan. For each entity, list required operations (CRUD, search, filter, etc.).
    
    STEP 2 — MATCH TO LIBRARY:
    For each entity/flow, check available_concepts for a match. Prefer library pulls.
    - Only pull a library concept if it maps to a SPECIFIC plan item.
    - One library concept can serve multiple purposes (e.g. one Commenting for Posts and Stories).
    - Multi-user apps MUST include Authenticating and Sessioning.
    - NEVER include Requesting/API/Gateway — added automatically.
    - NEVER duplicate a library concept as a custom concept.
    
    CRUD COMPLETENESS GATE: Before pulling a library concept, verify its actions and queries
    cover ALL operations the plan requires. If the library concept is missing needed operations
    (e.g. no edit/update, no search query, no count), create a custom concept instead.
    
    STEP 3 — CUSTOM CONCEPTS (for gaps and incomplete library matches):
    Only create a custom concept if (a) a specific plan item requires it AND (b) no library concept covers all needed operations.
    Write specs in context_docs format. Include full CRUD actions and inverses for reversible actions.

    AI-SPECIFIC GUIDANCE:
    - If the plan calls for AI capabilities, prefer the matching AI library concepts from available_concepts.
    - Do NOT pull or spec AI concepts unless the plan actually requires AI behavior.
    - Where appropriate, compose AI concepts with non-AI concepts rather than folding unrelated persistence and AI concerns into one custom concept.
    """

    plan: str = dspy.InputField(desc="The JSON plan describing the application's entities, flows, and requirements.")
    available_concepts: str = dspy.InputField(desc="Markdown catalog of available library concepts and their specs.")
    context_docs: str = dspy.InputField(desc="Reference documentation for Concept Design specifications.")
    
    plan_needs: str = dspy.OutputField(desc="List every entity/flow from the plan with required operations (create, read, update, delete, list, filter, etc.).")
    library_audit: str = dspy.OutputField(desc="For each library concept considered: (a) operations needed, (b) provided, (c) missing. PASS if complete, FAIL with gaps. Only pull concepts that PASS.")
    output: DesignOutput = dspy.OutputField(desc="The design. Library pulls must pass the CRUD audit. Custom concepts must include complete CRUD lifecycles.")

class ModifyDesignSignature(dspy.Signature):
    """
    Update an existing software design based on feedback and a potentially revised plan.
    
    INSTRUCTIONS:
    1. Review current_design, then apply feedback and align with plan.
    2. You can add/remove library pulls or add/remove/update custom concepts.
    3. Follow the same rules as new design (no duplicates, SSF state, etc.).
    4. CRUD COMPLETENESS GATE: For every library concept, verify its actions/queries cover all
       plan-required operations. Replace incomplete library pulls with custom concepts.
    5. Custom concepts must have full CRUD + inverses for reversible actions.
    6. If the plan or feedback calls for AI behavior, use matching AI library concepts when they fit.
       Only create custom AI concepts for genuine gaps, and keep them narrowly scoped.
    
    CRITICAL — SURGICAL CHANGES ONLY:
    - ONLY modify concepts explicitly mentioned in the feedback. Every library pull and
      custom concept NOT mentioned in the feedback MUST be reproduced EXACTLY as-is in
      your output — same name, same spec, same actions, same queries.
    - NEVER drop, rename, or rewrite a concept that the feedback did not flag.
    - NEVER remove queries or actions from a concept unless the feedback specifically
      asks for their removal. Losing unflagged content is the #1 failure mode.
    - If the feedback says to fix concept X, output concept X with fixes applied AND
      every other concept unchanged.
    """
    
    plan: str = dspy.InputField(desc="The updated JSON plan.")
    current_design: str = dspy.InputField(desc="The current JSON design (library pulls and custom concepts).")
    feedback: str = dspy.InputField(desc="User feedback requesting changes.")
    available_concepts: str = dspy.InputField(desc="Markdown catalog of available library concepts.")
    context_docs: str = dspy.InputField(desc="Reference documentation.")
    
    library_audit: str = dspy.OutputField(desc="For each library concept: (a) operations needed, (b) provided, (c) missing. PASS/FAIL. Replace FAILed pulls with custom concepts.")
    output: DesignOutput = dspy.OutputField(desc="The modified design. Library pulls must pass CRUD audit. Custom concepts must have complete lifecycles.")

class ReviewDesign(dspy.Signature):
    """Review a concept design for completeness, correctness, and downstream viability.
    
    You are a strict, EXHAUSTIVE reviewer. Enumerate ALL problems in a SINGLE pass.
    Do NOT hold back issues for later rounds. Each iteration is expensive.
    
    Run through EVERY check below against EVERY library pull and EVERY custom concept,
    then report everything at once.

    CONTEXT CLARITY:
    - `available_concepts` is the full catalog of concepts that COULD be pulled from the library.
      It is not the selected design.
    - `design_json` is the selected design (library pulls + custom concepts).
    - Your job is to verify that selected `library_pulls` in `design_json` are valid choices from
      `available_concepts` and that those pulls fully satisfy the plan.
    
    Checks:
    
    1. PLAN COVERAGE: Every entity and user flow in the plan must be covered by at least
       one concept (library pull or custom). Flag any plan item with no concept backing it.
    
    2. CRUD COMPLETENESS: For each library pull, verify its actions/queries cover all
       operations the plan requires for the entities it serves. Flag library pulls missing
       needed operations (e.g., no update action when the plan has editable entities).
    
    3. CUSTOM SPEC QUALITY: Each custom concept spec must include: purpose, principle,
       state (in set-based format), actions with requires/effects, and queries. Flag specs
       missing any of these sections. Verify actions have proper argument/result signatures
       following the pattern: `actionName (arg1: Type1, arg2: Type2): (result: ResultType)`.
    
    4. NO REDUNDANCY: No library concept should duplicate a custom concept. No two custom
       concepts should serve the same purpose. Flag overlaps.
    
    5. SEPARATION OF CONCERNS: Each concept should address a single coherent concern. Flag
       custom concepts that conflate unrelated functionality (e.g., a single concept handling
       both messaging and notifications).
    
    6. MANDATORY CONCEPTS: Multi-user apps must include Authenticating and Sessioning.
       Flag if missing.
    
    7. FORBIDDEN CONCEPTS: Requesting/API/Gateway must not appear in the design (added
       automatically). Flag if present.
    
    8. SYMMETRY: For every reversible action in a custom concept (follow/unfollow,
       like/unlike, join/leave), verify the inverse action exists. Flag missing inverses.
    
    9. QUERY COVERAGE: Custom concepts must have queries sufficient to support ALL read
       operations implied by the plan — both user-facing flows AND automated/background
       flows (scheduled jobs, cron tasks, event-driven reactions). A plan that mentions
       periodic processing (e.g., "generate daily reports", "send reminders for upcoming
       events") implies queries that let the automation determine WHAT to process without
       external computation. Flag concepts with actions but no queries, and flag any
       plan flow (user-facing or automated) that lacks a supporting concept query.
    
    10. DATA TYPE CORRECTNESS: Verify that state declarations and action/query signatures use
        precise types. Flag incorrect type usage: e.g., Number where Float is needed (ratings,
        prices, coordinates), String where Date or Boolean is more appropriate. Types in the
        spec drive the MongoDB schema and TypeScript types downstream — imprecision here
        causes type bugs in implementation.
    
    11. COMPLEXITY AT THE CONCEPT LEVEL: Concepts should push data shaping and computation
        into their queries so that syncs remain thin orchestration glue. If a plan flow
        requires aggregated, filtered, joined, or transformed data (e.g., "feed of posts
        from followed users", "average rating", "unread message count"), the concept MUST
        define a query that returns exactly what the sync/endpoint will need. Additionally,
        when syncs generate items in one concept on behalf of another (e.g., auto-creating
        entries from a schedule, logging events from an action), the receiving concept MUST
        include a provenance field in its state that references the source, and expose
        queries and actions that operate by that source reference. Without provenance, the
        system cannot trace, display, or bulk-manage generated items. Flag any plan flow
        whose data or traceability requirements would force complex logic into syncs.
    
    12. RELATIONSHIP SEPARATION: If a single concept manages both a parent entity AND a
        dependent relationship (e.g., groups AND membership, categories AND categorized items,
        threads AND thread participants), flag it and recommend splitting into separate
        concepts — one for the entity, one for the relationship. Examples: Grouping (manages
        groups) + Joining (manages membership), Categorizing (manages categories) +
        Transacting (manages transactions). This keeps concepts independent and lets syncs
        handle cascade behavior (e.g., "when Grouping.delete(group), then
        Joining.removeAll(group)"). A concept that conflates entity management with
        relationship management will inevitably need internal cascade logic that should
        instead be explicit synchronization.
    
    13. BULK ACTION COVERAGE: Just as queries must serve the sync layer's read needs (check
        11), actions must serve its write needs. When the plan implies operations that affect
        many items at once — cascade deletions, batch creation, or mass updates — the
        concept MUST provide a dedicated bulk action. Without bulk actions, syncs are forced
        to loop over individual items, which is both fragile and slow. For every entity in
        the concept, consider: can another concept's deletion trigger a bulk cleanup here?
        Can the plan's flows create/update/delete many items at once? If a concept tracks
        provenance (check 11), it MUST also have bulk actions that operate by source
        reference (e.g., deleteBySource, getBySource) so that canceling or deleting the
        source can cleanly cascade to all generated items.
    
    IMPORTANT: Base your review on what the PLAN describes. Do not demand features the plan
    doesn't call for.
    
    REVIEW CONTINUITY: If previous_review is provided, use it as a checklist:
    - For each issue you flagged before, verify it was ACTUALLY fixed. If still broken,
      re-flag it explicitly.
    - Do NOT re-report issues that were successfully fixed.
    - Do NOT contradict your previous review (e.g., demanding X then demanding the opposite).
    - Focus new findings on issues not covered in the previous review.
    
    If ALL checks pass, set verdict to "accept".
    Otherwise, set verdict to "revise" and provide specific critique.
    """
    
    plan: str = dspy.InputField(desc="The application plan.")
    available_concepts: str = dspy.InputField(desc="Full raw catalog of ALL available library concepts the designer can pull from. This is availability context, NOT the selected design.")
    design_json: str = dspy.InputField(desc="The generated design as JSON (library_pulls and custom_concepts). This contains the selected library pulls and all custom concept specs.")
    previous_review: str = dspy.InputField(desc="Your previous review output (issues + critique), or empty string on first review. Use as a checklist to verify fixes and avoid contradictions.")
    
    issues: str = dspy.OutputField(desc="EXHAUSTIVE list of ALL problems found across all checks, or 'None' if all checks pass. Do not omit issues to be brief.")
    verdict: str = dspy.OutputField(desc="Either 'accept' or 'revise'.")
    critique: str = dspy.OutputField(desc="ALL fixes needed, with specific actionable instructions for each issue. Empty string if design is fine.")


class ConceptDesigner:
    def __init__(self):
        self.context = self._load_context()
        self.generator = dspy.ChainOfThought(ConceptDesigningSignature)
        self.modifier = dspy.ChainOfThought(ModifyDesignSignature)
        self.reviewer = dspy.ChainOfThought(ReviewDesign)

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

    def _review_loop(self, plan: str, available_concepts: str, design_result: Dict[str, Any], max_iterations: int = 5) -> Dict[str, Any]:
        """Run review-revise cycle on a design until reviewer accepts or max iterations reached."""
        if "error" in design_result:
            return design_result

        current_design = design_result
        prev_review_text = ""

        for iteration in range(max_iterations):
            iter_label = f"[Review {iteration + 1}/{max_iterations}]"

            design_json = json.dumps({
                "library_pulls": current_design.get("libraryPulls", []),
                "custom_concepts": current_design.get("customConcepts", [])
            }, indent=2)

            review_context = prev_review_text
            if review_context:
                review_context += "\n\nIMPORTANT: Perform a full, exhaustive review. Do NOT stop after the first issue."
            else:
                review_context = ""

            print(f"{iter_label} Reviewing design...", file=sys.stderr)

            def _valid_review(r):
                return bool((getattr(r, 'verdict', None) or "").strip())

            try:
                review = self._call_with_retry(
                    self.reviewer,
                    is_valid=_valid_review,
                    plan=plan,
                    available_concepts=available_concepts,
                    design_json=design_json,
                    previous_review=review_context
                )
            except Exception as e:
                print(f"{iter_label} Review failed: {e}. Proceeding with current design.", file=sys.stderr)
                break

            verdict = (review.verdict or "").strip().lower()

            if "accept" in verdict:
                print(f"{iter_label} Review PASSED.", file=sys.stderr)
                return current_design

            critique = (review.critique or "").strip()
            issues = (review.issues or "").strip()
            print(f"{iter_label} Review found issues: {issues}", file=sys.stderr)

            prev_review_text = f"ISSUES: {issues}\nCRITIQUE: {critique}"

            if not critique:
                print(f"{iter_label} Reviewer said revise but provided no critique. Proceeding.", file=sys.stderr)
                break

            # Revise: feed critique into modifier
            print(f"{iter_label} Revising design based on critique...", file=sys.stderr)

            def _valid_modify(p):
                return hasattr(p, "output") and p.output is not None

            feedback_text = (
                f"REVIEWER FEEDBACK (you MUST fix these issues):\n{critique}\n\n"
                f"CRITICAL: ONLY change what the reviewer flagged above. Every library pull "
                f"and custom concept NOT mentioned in the feedback must appear in your output "
                f"EXACTLY as-is — same actions, queries, state, and spec text. Do NOT drop, "
                f"rename, or rewrite unflagged concepts."
            )

            try:
                prediction = self._call_with_retry(
                    self.modifier,
                    is_valid=_valid_modify,
                    plan=plan,
                    current_design=design_json,
                    feedback=feedback_text,
                    available_concepts=available_concepts,
                    context_docs=self.context
                )
            except Exception as e:
                print(f"{iter_label} Revision failed: {e}. Proceeding with current design.", file=sys.stderr)
                break

            if hasattr(prediction, 'output') and prediction.output:
                data = prediction.output.model_dump()
                current_design = {
                    "libraryPulls": data.get("library_pulls", []),
                    "customConcepts": data.get("custom_concepts", [])
                }
                lib_count = len(current_design["libraryPulls"])
                custom_count = len(current_design["customConcepts"])
                print(f"{iter_label} Revised design: {lib_count} library pulls, {custom_count} custom concepts.", file=sys.stderr)
            else:
                print(f"{iter_label} Revision produced no valid output. Proceeding with current design.", file=sys.stderr)
                break

            if iteration == max_iterations - 1:
                print(f"Max review iterations reached. Proceeding with current design.", file=sys.stderr)

        return current_design

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
            initial_result = {
                "libraryPulls": data.get("library_pulls", []),
                "customConcepts": data.get("custom_concepts", [])
            }
            return self._review_loop(plan, available_concepts, initial_result)
        
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
            initial_result = {
                "libraryPulls": data.get("library_pulls", []),
                "customConcepts": data.get("custom_concepts", [])
            }
            return self._review_loop(plan, available_concepts, initial_result)
        
        return {
            "libraryPulls": [],
            "customConcepts": [],
            "error": "Failed to modify design"
        }
