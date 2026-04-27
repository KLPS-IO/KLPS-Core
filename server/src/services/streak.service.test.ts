import test from "node:test";
import assert from "node:assert/strict";

import { pool } from "../storage/postgres.client";
import { updateStreak } from "./streak.service";

type QueryResultRow = Record<string, unknown>;

type MockQueryResult = {
  rows: QueryResultRow[];
};

type QueryCall = {
  text: string;
  params: unknown[];
};

test("updateStreak uses max completed day_number as the computed streak", async () => {

  const calls: QueryCall[] = [];
  const originalQuery =
    pool.query.bind(pool);

  const queuedResults: MockQueryResult[] = [
    { rows: [{ computed_streak: 15 }] },
    {
      rows: [{
        current_streak: 14,
        longest_streak: 14,
        last_active: "2026-04-26"
      }]
    },
    { rows: [] }
  ];

  pool.query = (async (
    text: string,
    params?: unknown[]
  ) => {

    calls.push({
      text,
      params: params ?? []
    });

    const nextResult =
      queuedResults.shift();

    if (!nextResult) {
      throw new Error("Unexpected query");
    }

    return nextResult;

  }) as typeof pool.query;

  try {

    await updateStreak({
      user_id:
        "11111111-1111-1111-1111-111111111111",
      timezone: "Europe/London"
    });

    assert.equal(calls.length, 3);
    assert.match(
      calls[0].text,
      /SELECT COALESCE\(MAX\(day_number\), 1\)::int AS computed_streak/
    );
    assert.match(
      calls[0].text,
      /completion_status = 'completed'/
    );
    assert.match(
      calls[2].text,
      /current_streak =\s+GREATEST\(current_streak, \$1\)/
    );
    assert.match(
      calls[2].text,
      /longest_streak =\s+GREATEST\(longest_streak, current_streak, \$1\)/
    );
    assert.deepEqual(
      calls[2].params,
      [
        15,
        "Europe/London",
        "11111111-1111-1111-1111-111111111111"
      ]
    );

  } finally {

    pool.query = originalQuery;

  }

});

test("updateStreak prevents downgrading an existing higher streak", async () => {

  const calls: QueryCall[] = [];
  const warnings: string[] = [];

  const originalQuery =
    pool.query.bind(pool);
  const originalWarn =
    console.warn;

  const queuedResults: MockQueryResult[] = [
    { rows: [{ computed_streak: 10 }] },
    {
      rows: [{
        current_streak: 15,
        longest_streak: 15,
        last_active: "2026-04-26"
      }]
    },
    { rows: [] }
  ];

  pool.query = (async (
    text: string,
    params?: unknown[]
  ) => {

    calls.push({
      text,
      params: params ?? []
    });

    const nextResult =
      queuedResults.shift();

    if (!nextResult) {
      throw new Error("Unexpected query");
    }

    return nextResult;

  }) as typeof pool.query;

  console.warn = ((
    ...args: unknown[]
  ) => {
    warnings.push(
      args.map(String).join(" ")
    );
  }) as typeof console.warn;

  try {

    await updateStreak({
      user_id:
        "22222222-2222-2222-2222-222222222222"
    });

    assert.equal(calls.length, 3);
    assert.match(
      calls[2].text,
      /GREATEST\(current_streak, \$1\)/
    );
    assert.equal(calls[2].params[0], 10);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /Streak downgrade prevented/
    );

  } finally {

    pool.query = originalQuery;
    console.warn = originalWarn;

  }

});

test("updateStreak inserts first streak from completed sessions", async () => {

  const calls: QueryCall[] = [];
  const originalQuery =
    pool.query.bind(pool);

  const queuedResults: MockQueryResult[] = [
    { rows: [{ computed_streak: 10 }] },
    { rows: [] },
    { rows: [] }
  ];

  pool.query = (async (
    text: string,
    params?: unknown[]
  ) => {

    calls.push({
      text,
      params: params ?? []
    });

    const nextResult =
      queuedResults.shift();

    if (!nextResult) {
      throw new Error("Unexpected query");
    }

    return nextResult;

  }) as typeof pool.query;

  try {

    await updateStreak({
      user_id:
        "33333333-3333-3333-3333-333333333333",
      timezone: "Africa/Tunis"
    });

    assert.equal(calls.length, 3);
    assert.match(
      calls[2].text,
      /INSERT INTO lema\.streaks/
    );
    assert.deepEqual(
      calls[2].params,
      [
        "33333333-3333-3333-3333-333333333333",
        10,
        "Africa/Tunis"
      ]
    );

  } finally {

    pool.query = originalQuery;

  }

});
