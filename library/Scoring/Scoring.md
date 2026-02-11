**concept** Scoring [Subject, Context]

**purpose**
Record and query numeric values (scores, points, metrics) associated with a subject in a specific context.

**principle**
A score is a numeric value tied to a subject and a context; it can be set directly or incrementally updated.

**state**
  a set of Scores with
    a subject (Subject)
    a context (Context)
    a value Number
    a updatedAt DateTime

**actions**

setScore (subject: Subject, context: Context, value: Number) : (ok: Flag)
  **requires**
    value is a number
  **effects**
    sets the score for the subject in the context to the given value

addScore (subject: Subject, context: Context, delta: Number) : (newScore: Number)
  **requires**
    delta is a number
  **effects**
    increments (or decrements if negative) the score for the subject in the context by delta (initializing to 0 if none exists)

remove (subject: Subject, context: Context) : (ok: Flag)
  **requires**
    score exists for the subject in the context
  **effects**
  **effects**
    removes the score record for the subject in the context

spend (subject: Subject, context: Context, amount: Number) : (ok: Flag)
  **requires**
    amount > 0, score >= amount
  **effects**
    decrements score by amount

transfer (from: Subject, to: Subject, context: Context, amount: Number) : (ok: Flag)
  **requires**
    amount > 0, from has score >= amount
  **effects**
    decrements from's score by amount, increments to's score by amount

**lifecycle cleanup**

deleteBySubject (subject: Subject) : (ok: Flag)
  **effects** removes all scores for the subject (e.g. account deletion)

deleteByContext (context: Context) : (ok: Flag)
  **effects** removes all scores in the context (e.g. game/context removal)

**queries**

_getScore (subject: Subject, context: Context) : (value: Number)
  **requires** true
  **effects** returns the current score, defaulting to 0 if not set

_getLeaderboard (context: Context, limit: Number, ascending?: Flag) : (scores: List<{subject: Subject, value: Number}>)
  **requires** true
  **effects** returns the top scores for the context, sorted by value
