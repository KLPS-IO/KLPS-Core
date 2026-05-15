import test from "node:test";
import assert from "node:assert/strict";

import { pool } from "../storage/postgres.client";
import { detectPatterns } from "./pattern.service";

type QueryResultRow = Record<string, unknown>;

type MockQueryResult = {
  rows: QueryResultRow[];
};

type QueryCall = {
  text: string;
  params: unknown[];
};

test("detectPatterns ignores empty and non-string response values safely", async () => {

  const calls: QueryCall[] = [];
  const originalQuery =
    pool.query.bind(pool);
  const originalLog =
    console.log;

  const queuedResults: MockQueryResult[] = [
    {
      rows: [
        {
          question_key: "empty",
          response_value: null
        },
        {
          question_key: "choice",
          response_value: ["calm", "productive"]
        },
        {
          question_key: "object",
          response_value: {
            label: "Low energy"
          }
        }
      ]
    },
    { rows: [] },
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

  console.log = (() => undefined) as typeof console.log;

  try {

    await detectPatterns({
      user_id:
        "33333333-3333-3333-3333-333333333333",
      day_number: 13
    });

    assert.equal(calls.length, 4);
    assert.match(
      calls[1].text,
      /INSERT INTO lema\.daily_patterns/
    );
    assert.equal(
      calls[1].params[1],
      "calm"
    );
    assert.equal(
      calls[2].params[1],
      "productive"
    );
    assert.equal(
      calls[3].params[1],
      "low"
    );

  } finally {

    pool.query = originalQuery;
    console.log = originalLog;

  }

});
