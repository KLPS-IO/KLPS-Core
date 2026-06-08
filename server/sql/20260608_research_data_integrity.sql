ALTER TABLE public.survey_responses
  ADD COLUMN IF NOT EXISTS desired_insights jsonb,
  ADD COLUMN IF NOT EXISTS other_insight text,
  ADD COLUMN IF NOT EXISTS trusted_source text,
  ADD COLUMN IF NOT EXISTS spent_money_on jsonb;

CREATE OR REPLACE VIEW public.research_concern_counts AS
SELECT
  concern,
  COUNT(*)::int AS response_count
FROM public.survey_responses
CROSS JOIN LATERAL jsonb_each(
  CASE
    WHEN jsonb_typeof(concerns) = 'object'
    THEN concerns
    ELSE '{}'::jsonb
  END
) AS concern_groups(area, values_json)
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof(values_json) = 'array'
    THEN values_json
    ELSE '[]'::jsonb
  END
) AS concern
GROUP BY concern;

CREATE OR REPLACE VIEW public.research_desired_insight_counts AS
SELECT
  insight,
  COUNT(*)::int AS response_count
FROM public.survey_responses
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof(desired_insights) = 'array'
    THEN desired_insights
    ELSE '[]'::jsonb
  END
) AS insight
GROUP BY insight;

CREATE OR REPLACE VIEW public.research_trusted_source_counts AS
SELECT
  trusted_source,
  COUNT(*)::int AS response_count
FROM public.survey_responses
WHERE
  trusted_source IS NOT NULL
  AND trusted_source <> ''
GROUP BY trusted_source;

CREATE OR REPLACE VIEW public.research_metrics_summary AS
WITH totals AS (
  SELECT
    COUNT(*)::int AS participants
  FROM public.participants
),
top_concern AS (
  SELECT
    concern,
    response_count
  FROM public.research_concern_counts
  ORDER BY response_count DESC, concern ASC
  LIMIT 1
)
SELECT
  totals.participants,
  top_concern.concern AS top_concern,
  CASE
    WHEN totals.participants = 0
    THEN 0
    ELSE ROUND(
      top_concern.response_count * 100.0 /
      totals.participants,
      2
    )
  END AS top_concern_percent,
  CASE
    WHEN totals.participants = 0
    THEN 0
    ELSE ROUND(
      COUNT(*) FILTER (
        WHERE LOWER(
          COALESCE(
            survey_responses.spent_money,
            ''
          )
        ) IN ('yes', 'true', 'y')
      ) * 100.0 / totals.participants,
      2
    )
  END AS spent_money_percent,
  CASE
    WHEN totals.participants = 0
    THEN 0
    ELSE ROUND(
      COUNT(*) FILTER (
        WHERE LOWER(
          COALESCE(
            survey_responses.would_pay,
            ''
          )
        ) IN ('yes', 'true', 'y')
      ) * 100.0 / totals.participants,
      2
    )
  END AS would_pay_percent
FROM totals
LEFT JOIN top_concern ON true
LEFT JOIN public.survey_responses ON true
GROUP BY
  totals.participants,
  top_concern.concern,
  top_concern.response_count;
