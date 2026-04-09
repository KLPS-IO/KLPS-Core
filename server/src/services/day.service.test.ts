import test from "node:test";
import assert from "node:assert/strict";

import { pool } from "../storage/postgres.client";
import {
  getCurrentDay,
  getSafeCurrentDay
} from "./day.service";

type QueryResultRow = Record<string, unknown>;

type MockQueryResult = {
  rows: QueryResultRow[];
};

type QueryCall = {
  text: string;
  params: unknown[];
};

test("getCurrentDay bootstraps a new user streak and returns day 1", async () => {

  const calls: QueryCall[] = [];

  const originalQuery =
    pool.query.bind(pool);

  const queuedResults: MockQueryResult[] = [
    { rows: [] },
    { rows: [{ current_day: 1 }] }
  ];

  pool.query = (async (
    text: string,
    params?: unknown[]
  ) => {

    calls.push({
      text,
      params: params ?? []
    });

    if (text.includes("INSERT INTO lema.streaks")) {
      return { rows: [] };
    }

    const nextResult =
      queuedResults.shift();

    if (!nextResult) {
      throw new Error("Unexpected query");
    }

    return nextResult;

  }) as typeof pool.query;

  try {

    const day =
      await getCurrentDay(
        "33333333-3333-3333-3333-333333333333"
      );

    assert.equal(day, 1);
    assert.equal(calls.length, 3);
    assert.match(calls[0].text, /FROM lema\.streaks/);
    assert.match(calls[1].text, /INSERT INTO lema\.streaks/);
    assert.match(calls[2].text, /FROM lema\.streaks/);
    assert.deepEqual(
      calls[1].params,
      ["33333333-3333-3333-3333-333333333333"]
    );

  } finally {

    pool.query = originalQuery;

  }

});

test("getCurrentDay returns the existing user day without bootstrapping", async () => {

  const calls: QueryCall[] = [];

  const originalQuery =
    pool.query.bind(pool);

  pool.query = (async (
    text: string,
    params?: unknown[]
  ) => {

    calls.push({
      text,
      params: params ?? []
    });

    return {
      rows: [{ current_day: 4 }]
    };

  }) as typeof pool.query;

  try {

    const day =
      await getCurrentDay(
        "11111111-1111-1111-1111-111111111111"
      );

    assert.equal(day, 4);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /FROM lema\.streaks/);

  } finally {

    pool.query = originalQuery;

  }

});

test("getSafeCurrentDay clamps the day to the protocol max", async () => {

  const originalQuery =
    pool.query.bind(pool);

  const calls: QueryCall[] = [];

  pool.query = (async (
    text: string,
    params?: unknown[]
  ) => {

    calls.push({
      text,
      params: params ?? []
    });

    if (text.includes("FROM lema.streaks")) {
      return {
        rows: [{ current_day: 9 }]
      };
    }

    if (text.includes("FROM lema.questions")) {
      return {
        rows: [{ max_day: 3 }]
      };
    }

    throw new Error("Unexpected query");

  }) as typeof pool.query;

  try {

    const day =
      await getSafeCurrentDay({
        userId:
          "22222222-2222-2222-2222-222222222222",
        protocolVersion: "EARLY_V1"
      });

    assert.equal(day, 3);
    assert.equal(calls.length, 2);
    assert.match(calls[0].text, /FROM lema\.streaks/);
    assert.match(calls[1].text, /FROM lema\.questions/);

  } finally {

    pool.query = originalQuery;

  }

});
