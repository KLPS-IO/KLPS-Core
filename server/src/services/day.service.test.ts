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

test("getCurrentDay returns day 1 when the user has no completed summary", async () => {

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

    return { rows: [] };

  }) as typeof pool.query;

  try {

    const day =
      await getCurrentDay(
        "33333333-3333-3333-3333-333333333333"
      );

    assert.equal(day, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /FROM lema\.daily_summaries/);

  } finally {

    pool.query = originalQuery;

  }

});

test("getCurrentDay stays on the same day when the latest summary was created today", async () => {

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
      rows: [{
        day_number: 4,
        diff_days: 0
      }]
    };

  }) as typeof pool.query;

  try {

    const day =
      await getCurrentDay(
        "11111111-1111-1111-1111-111111111111"
      );

    assert.equal(day, 4);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /FROM lema\.daily_summaries/);

  } finally {

    pool.query = originalQuery;

  }

});

test("getCurrentDay advances when the latest summary was completed on a prior calendar day", async () => {

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
      rows: [{
        day_number: 4,
        diff_days: 1
      }]
    };

  }) as typeof pool.query;

  try {

    const day =
      await getCurrentDay(
        "11111111-1111-1111-1111-111111111111"
      );

    assert.equal(day, 5);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /FROM lema\.daily_summaries/);

  } finally {

    pool.query = originalQuery;

  }

});

test("getSafeCurrentDay clamps the day to the protocol max", async () => {

  const originalQuery =
    pool.query.bind(pool);

  const calls: QueryCall[] = [];

  const queuedResults: MockQueryResult[] = [
    {
      rows: [{
        day_number: 9,
        diff_days: 1
      }]
    },
    { rows: [{ max_day: 3 }] }
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

    const day =
      await getSafeCurrentDay({
        userId:
          "22222222-2222-2222-2222-222222222222",
        protocolVersion: "EARLY_V1"
      });

    assert.equal(day, 3);
    assert.equal(calls.length, 2);
    assert.match(calls[0].text, /FROM lema\.daily_summaries/);
    assert.match(calls[1].text, /FROM lema\.questions/);

  } finally {

    pool.query = originalQuery;

  }

});
