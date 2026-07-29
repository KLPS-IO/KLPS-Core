import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  changeCommunityStage,
  deterministicDraft,
  ensureCommunityProfile,
  getCommunitySummary,
  listCommunityPeople
} from "../growth/community.service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const waitlistId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";

test("Phase 3 migration references and never copies canonical waitlist identity", () => {
  const sql = readFileSync("server/sql/20260730_growth_os_phase3.sql", "utf8");
  assert.match(sql, /REFERENCES public\.waitlist_signups\(id\)/);
  assert.doesNotMatch(sql, /INSERT INTO public\.waitlist_signups/i);
  assert.match(sql, /UNIQUE \(workspace_id, waitlist_signup_id\)/);
});

test("community summary returns aggregates without personal fields", async () => {
  let captured = "";
  const db = {
    query: async (sql: string) => {
      captured = sql;
      return { rows: [{ total_waitlist_signups: 2, source_distribution: { waitlist: 2 } }] };
    }
  };
  const summary = await getCommunitySummary(workspaceId, db as never);
  assert.equal(summary.total_waitlist_signups, 2);
  assert.doesNotMatch(captured, /w\.name|w\.email|w\.phone/);
  assert.equal("email" in summary, false);
});

test("joined people query reads future signups without requiring profiles", async () => {
  let captured = "";
  const db = {
    query: async (sql: string) => {
      captured = sql;
      return { rows: [{ waitlist_id: waitlistId, name: "Person", total: 1 }] };
    }
  };
  const result = await listCommunityPeople(workspaceId, {}, db as never);
  assert.equal(result.total, 1);
  assert.match(captured, /FROM public\.waitlist_signups w/);
  assert.match(captured, /LEFT JOIN growth_os\.community_profiles p/);
});

test("profile creation is lazy and idempotent", async () => {
  let captured = "";
  const db = {
    query: async (sql: string) => {
      captured = sql;
      return { rows: [{ id: "44444444-4444-4444-8444-444444444444", relationship_stage: "new" }] };
    }
  };
  await ensureCommunityProfile(workspaceId, waitlistId, db as never);
  assert.match(captured, /ON CONFLICT\(workspace_id,waitlist_signup_id\)/);
});

test("stage changes create history before updating the profile", async () => {
  const queries: string[] = [];
  const profile = { id: "44444444-4444-4444-8444-444444444444", relationship_stage: "new" };
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("INSERT INTO growth_os.community_profiles")) return { rows: [profile] };
      if (sql.includes("UPDATE growth_os.community_profiles")) return { rows: [{ ...profile, relationship_stage: "engaged" }] };
      return { rows: [] };
    }
  };
  await changeCommunityStage(workspaceId, waitlistId, userId, { stage: "engaged", reason: "Founder confirmed" }, db as never);
  assert.ok(queries.findIndex(sql => sql.includes("relationship_stage_history")) < queries.findIndex(sql => sql.includes("UPDATE growth_os.community_profiles")));
});

test("deterministic drafts block opted-out people", () => {
  assert.throws(() => deterministicDraft("welcome", "Person", "opted_out"), /blocked/);
  assert.match(deterministicDraft("welcome", "Deborah Person", "reviewed"), /Hi Deborah/);
});
