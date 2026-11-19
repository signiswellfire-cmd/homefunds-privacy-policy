import assert from "node:assert/strict";
import {test} from "node:test";
import worker from "../src/index.js";

const ORIGIN = "https://homefunds.signiswellfire.com";
const URL = "https://feedback-api.signiswellfire.com/v1/feedback";

function makeEnv(duplicate = null) {
  const calls=[];
  const env={
    SITE_ORIGIN:ORIGIN,
    TURNSTILE_HOSTNAME:"homefunds.signiswellfire.com",
    TURNSTILE_SECRET:"turnstile-test-secret",
    VOTER_COOKIE_SECRET:"voter-test-key",
    RATE_LIMIT_SECRET:"rate-test-key",
    ADMIN_TOKEN:"admin-secret-longer-than-twenty-characters",
    DB:{
      prepare(sql) {
        const call={sql,values:[]};
        calls.push(call);
        return {
          bind(...values) {call.values=values;return this;},
          async run() {return {meta:{changes:1}};},
          async first() {
            if(sql.includes("SELECT id,status FROM feedback")) return duplicate;
            return null;
          },
          async all() {return {results:[]};}
        };
      }
    }
  };
  return {env,calls};
}
function feedbackRequest(body) {
  return new Request(URL,{
    method:"POST",
    headers:{Origin:ORIGIN,"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
}
const good={
  title:"Add monthly savings goals",
  details:"Please offer a monthly savings progress widget and tracking.",
  category:"feature",
  submitterName:"Helpful tester",
  acceptedTerms:true,
  turnstileToken:"fake-verification-token-for-unit-test"
};
async function withTurnstile(fn) {
  const original=globalThis.fetch;
  globalThis.fetch=async () => new Response(JSON.stringify({
    success:true,hostname:"homefunds.signiswellfire.com",action:"feedback"
  }),{status:200,headers:{"Content-Type":"application/json"}});
  try {return await fn();} finally {globalThis.fetch=original;}
}

test("feedback no longer demands an adult-only confirmation",async()=>{
  await withTurnstile(async()=>{
    const {env,calls}=makeEnv();
    const response=await worker.fetch(feedbackRequest(good),env);
    assert.equal(response.status,202);
    assert.equal((await response.json()).status,"pending");
    const insert=calls.find(x=>x.sql.includes("INSERT INTO feedback("));
    assert.ok(insert,"feedback INSERT must occur");
    assert.ok(insert.sql.includes("submitter_name"));
    assert.ok(insert.values.includes("Helpful tester"));
  });
});
test("submission still requires acceptance of community rules",async()=>{
  const {env}=makeEnv();
  const response=await worker.fetch(feedbackRequest({...good,acceptedTerms:false}),env);
  assert.equal(response.status,400);
});
test("optional name can be empty while financial data remains separate",async()=>{
  await withTurnstile(async()=>{
    const {env,calls}=makeEnv();
    const response=await worker.fetch(feedbackRequest({...good,submitterName:""}),env);
    assert.equal(response.status,202);
    const insert=calls.find(x=>x.sql.includes("INSERT INTO feedback("));
    assert.ok(insert.values.includes(null),"empty optional name should not be stored");
  });
});
test("the same browser's duplicate submission is not inserted twice",async()=>{
  await withTurnstile(async()=>{
    const {env,calls}=makeEnv({id:"existing-id",status:"pending"});
    const response=await worker.fetch(feedbackRequest(good),env);
    assert.equal(response.status,200);
    assert.equal((await response.json()).duplicate,true);
    assert.equal(calls.some(x=>x.sql.includes("INSERT INTO feedback(")),false);
  });
});
test("emails and URLs are not allowed in optional name",async()=>{
  const {env}=makeEnv();
  const response=await worker.fetch(feedbackRequest({...good,submitterName:"person@example.com"}),env);
  assert.equal(response.status,400);
});
