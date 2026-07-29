/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashPassword, validateFounderPassword, verifyPassword } from "../rd-lab/rd-auth.service";
import { requireRdFounder, validateRdPayload } from "../rd-lab/rd-lab.service";

test("founder passwords are strength checked, scrypt hashed and verifiable", async () => {
  assert.throws(() => validateFounderPassword("too-short"), /14 characters/);
  const encoded = await hashPassword("Strong-RD-Password-2026!");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes("Strong-RD-Password-2026!"), false);
  assert.equal(await verifyPassword("Strong-RD-Password-2026!", encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
});

test("R&D access is founder_admin only", () => {
  assert.doesNotThrow(() => requireRdFounder("founder_admin"));
  assert.throws(() => requireRdFounder("authorised_user"), /Founder\/admin/);
});

test("supplier validation rejects bad URL and accepts controlled values", () => {
  assert.throws(() => validateRdPayload("suppliers", {
    work_package_id:"33333333-3333-4333-8333-333333333333", organisation_name:"Supplier",
    category:"Graphene Material Specialist", website:"javascript:alert(1)", change_reason:"Initial research"
  }), /valid HTTP URL/);
  const value=validateRdPayload("suppliers", {
    work_package_id:"33333333-3333-4333-8333-333333333333", organisation_name:"Supplier",
    category:"Graphene Material Specialist", procurement_status:"Research", change_reason:"Initial research"
  });
  assert.equal(value.procurement_status,"Research");
  assert.deepEqual(validateRdPayload("suppliers", {
    work_package_id:"33333333-3333-4333-8333-333333333333", organisation_name:"Supplier",
    organisation_aliases:["Supplier Labs","SL"], category:"Graphene Material Specialist",
    source_reference:"https://example.com/supplier", procurement_status:"Verified", change_reason:"Verified identity"
  }).organisation_aliases,["Supplier Labs","SL"]);
});

test("contacts reject invalid email and updates require a change reason", () => {
  assert.throws(() => validateRdPayload("contacts", {
    supplier_id:"33333333-3333-4333-8333-333333333333",full_name:"Person",email:"bad",change_reason:"Initial"
  }), /valid email/);
  assert.throws(() => validateRdPayload("actions",{status:"Complete"},true), /change_reason/);
});

test("quotation money remains nullable and finite numeric strings are accepted", () => {
  const quote=validateRdPayload("quotations",{
    supplier_id:"33333333-3333-4333-8333-333333333333",work_package_id:"44444444-4444-4444-8444-444444444444",
    quote_reference:"Q-1",minimum_amount:null,likely_amount:"1200.50",maximum_amount:null,change_reason:"Initial quote"
  });
  assert.equal(quote.minimum_amount,null);assert.equal(quote.likely_amount,1200.5);assert.equal(quote.maximum_amount,null);
  assert.throws(()=>validateRdPayload("quotations",{
    supplier_id:"33333333-3333-4333-8333-333333333333",work_package_id:"44444444-4444-4444-8444-444444444444",
    quote_reference:"Q-2",likely_amount:"Not confirmed",change_reason:"Initial quote"
  }),/finite money/);
});

test("migration seeds only WP1 and adds R&D evidence targets without suppliers", () => {
  const sql=readFileSync(join(process.cwd(),"server/sql/20260727_rd_lab_wp1.sql"),"utf8");
  assert.match(sql,/INSERT INTO rd_lab\.work_packages/);
  assert.doesNotMatch(sql,/INSERT INTO rd_lab\.suppliers/);
  assert.match(sql,/rd_work_package.*rd_supplier.*rd_rfq.*rd_quotation/s);
});

test("approved supplier sprint migration contains only the four verified identities and no capability claims", () => {
  const sql=readFileSync(join(process.cwd(),"server/sql/20260728_wp1_supplier_verification_sprint.sql"),"utf8");
  for(const supplier of [
    "The University of Manchester",
    "Henry Royce Institute",
    "Interactive Wear AG",
    "Ohmatex A/S"
  ]) assert.match(sql,new RegExp(supplier));
  assert.doesNotMatch(sql,/paid_feasibility_status\s*,/);
  assert.doesNotMatch(sql,/relevant_capability\s*,/);
  assert.match(sql,/Ohmatex was bankrupt/);
  assert.match(sql,/ON CONFLICT DO NOTHING/);
});

test("routes use canonical sessions, generic credentials errors, and rate limiting", () => {
  const routes=readFileSync(join(process.cwd(),"server/src/rd-lab/rd-lab.routes.ts"),"utf8");
  const auth=readFileSync(join(process.cwd(),"server/src/rd-lab/rd-auth.service.ts"),"utf8");
  assert.match(routes,/createSession/);assert.match(routes,/Invalid email or password/);assert.match(routes,/requireDataRoomAuth/);
  assert.match(auth,/interval '15 minutes'/);assert.match(auth,/failures.*>= 5/s);
});
