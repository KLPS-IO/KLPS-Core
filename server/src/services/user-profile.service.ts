import { pool } from "../storage/postgres.client";

type EnsureUserProfileInput = {
  userId: string;
  cohortVersion: string;
};

export const ensureUserProfile = async ({
  userId,
  cohortVersion
}: EnsureUserProfileInput) => {

  const result = await pool.query(
    `
    INSERT INTO lema.user_profiles (
      id,
      user_type,
      region,
      country,
      city,
      cohort_version,
      analytics_population,
      created_at
    )
    VALUES (
      $1,
      'beta',
      'UK',
      'United Kingdom',
      'Birmingham',
      $2,
      'genuine_beta',
      NOW()
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
    `,
    [
      userId,
      cohortVersion
    ]
  );

  return {
    created:
      result.rows.length > 0
  };

};
