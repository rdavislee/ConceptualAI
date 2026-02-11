**concept** Rating [Subject, Target]

**purpose**
Allow subjects to provide quantitative feedback (scores) on targets, and aggregate these scores to show overall sentiment.

**principle**
If a subject rates a target with a score, then the score is stored; if they rate it again, the old score is replaced; if they remove their rating, the score is deleted. Aggregates (like average rating) are calculated based on all active ratings for a target.

**state**
  a set of Ratings with
    a subject (Subject)
    a target (Target)
    a score Number
    a createdAt DateTime

**actions**

rate (subject: Subject, target: Target, score: Number) : (ok: Flag)
  **requires**
    score is within a valid range (e.g., 1 to 5)
  **effects**
    stores or updates the subject's score for the target with createdAt := now

removeRating (subject: Subject, target: Target) : (ok: Flag)
  **requires**
    subject has an existing rating for the target
  **effects**
    removes the subject's rating for the target

**queries**

_getAverageRating (target: Target) : (average: Number, count: Number)
  **requires** true
  **effects** returns the mean of all ratings for the target and the total count

_getUserRating (subject: Subject, target: Target) : (score: Number | null)
  **requires** true
  **effects** returns the rating given by the subject for the target, or null if none
