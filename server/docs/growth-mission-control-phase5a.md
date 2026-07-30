# Growth OS Mission Control Phase 5A

## Purpose

Mission Control derives deterministic next-action candidates from canonical Growth
OS records. It does not use generative AI, fabricate facts, or automatically create
missions.

A **candidate** is calculated current advice. A **mission** is a persisted founder
commitment. Selecting **Use suggested mission** copies the candidate identity,
source, expected outcome, completion condition, and cooldown policy into one saved
mission.

## Candidate sources

- Social: configured providers not connected, LinkedIn identity readiness, and
  unhealthy connections. LinkedIn identity never implies publishing permission.
- Community: overdue or high-priority follow-ups, unreviewed waitlist members,
  high-value MVP qualifications without a next action, and unresolved referrals.
- Content: schedulable prepared content, near-term final reviews, stalled content,
  prepared content awaiting publication, and campaign content preparation.
- Strategy: active sprint goals with current deadlines.
- Intelligence: active insights awaiting a founder review state.
- Metrics: no current weekly metric snapshot.

## Ranking

Candidates receive a deterministic score from urgency, business importance,
deadline proximity, relationship impact, active-campaign relevance, and active-
sprint alignment. Overdue founder commitments receive a strong relationship and
deadline weighting so routine content administration cannot permanently dominate.

Candidates with an equivalent planned or active mission are suppressed.
Explicitly dismissed recommendations are suppressed using the source-specific
skipped cooldown without creating a mission.

## Completion evaluators

Supported evaluators inspect saved canonical state:

- social provider has the required connection status;
- waitlist profile has `reviewed_at`;
- follow-up status is `completed`;
- content has `scheduled_at`;
- campaign has prepared content;
- current-period metrics exist;
- insight is `actioned` or `archived`;
- MVP qualification has a profile next action;
- referral is `acknowledged` or `archived`;
- content or goal changed after mission acceptance;
- recent content was published.

When the condition is satisfied, the mission records `outcome_verified`. When it is
not satisfied, completion returns a confirmation requirement. The founder may close
the mission manually only with a reason of at least five characters; this records
`manual_closed` and never claims the outcome was verified.

Existing missions without completion metadata remain compatible and require a
reasoned manual close.

## Cooldowns and deduplication

Only one open mission may use a candidate key in a workspace. Default cooldowns:

| Source | Completed | Skipped | Manual close |
| --- | ---: | ---: | ---: |
| Social | 14 days | 7 days | 14 days |
| Content | 3 days | 1 day | 3 days |
| Campaign | 5 days | 2 days | 5 days |
| Community | 7 days | 2 days | 7 days |
| Strategy | 7 days | 2 days | 7 days |
| Intelligence | 7 days | 3 days | 7 days |
| Metrics | 6 days | 2 days | 6 days |

An urgent unresolved relationship commitment may override cooldown after one day.
Resolved underlying conditions remove candidates regardless of history.

## Progression

Completing, skipping, rescheduling, or manually closing a saved mission is followed
by a fresh Mission Control read. The next ranked calculated candidate is displayed
immediately. It is not saved until the founder explicitly accepts it.

Automatic assignment is intentionally disabled. A future workspace setting can
enable it only through an explicit founder decision.

## Known limitations

- Content has no dedicated final-review timestamp, so final-review missions require
  a reasoned manual close until that canonical workflow state exists.
- Passive candidate display events are not persisted because reading Mission
  Control remains read-only. Explicit recommendation dismissals are persisted and
  provide cooldown history.
- Provider publishing is not recommended until a supported publishing capability
  exists.
- Sprint completion and successor selection remain a separate future lifecycle
  phase. Development deployments do not complete missions, goals, or sprints.
