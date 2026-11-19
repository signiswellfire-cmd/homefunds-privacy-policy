import assert from "node:assert/strict";
import {test} from "node:test";
import worker from "../src/index.js";

const SITE_ORIGIN = "https://homefunds.signiswellfire.com";
const env = {
  SITE_ORIGIN,
  TURNSTILE_HOSTNAME:"homefunds.signiswellfire.com",
  TURNSTILE_SECRET:"turnstile-secret-for-testing",
  VOTER_COOKIE_SECRET:"long-voter-signature-secret-for-tests",
  RATE_LIMIT_SECRET:"long-rate-limit-secret-for-tests",
  ADMIN_TOKEN:"admin-secret-for-testing",
  DB:{ prepare() { throw new Error("DB should not be accessed by guard tests"); } }
};
const uri = "https://feedback-api.signiswellfire.com";
function request(path, method="GET", body=null, origin=null, auth=null) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (auth) headers.Authorization = auth;
  if (body !== null) headers["Content-Type"]="application/json";
  return new Request(uri + path, {
    method,
    headers,
    ...(body===null ? {} : {body:JSON.stringify(body)})
  });
}

test("health check is not a route for submitting data", async()=>{
  const response = await worker.fetch(request("/v1/health"), {});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ready:false});
});
test("unconfigured backend fails closed",async()=>{
  const response=await worker.fetch(request("/v1/feedback"),{});
  assert.equal(response.status,503);
});
test("foreign websites cannot submit feedback",async()=>{
  const response=await worker.fetch(request("/v1/feedback","POST",{
    title:"Feature request from foreign site",details:"A longer description",
    category:"feature",acceptedTerms:true,adultConfirmed:true,
    turnstileToken:"irrelevant token"
  },"https://malicious.example"),env);
  assert.equal(response.status,403);
});
test("missing adult and terms consent is rejected",async()=>{
  const response=await worker.fetch(request("/v1/feedback","POST",{
    title:"Feature request",details:"Would like a dashboard feature",
    category:"feature",turnstileToken:"dummy"
  },SITE_ORIGIN),env);
  assert.equal(response.status,400);
});
test("CORS is allowlisted and preflight succeeds",async()=>{
  const allowed=await worker.fetch(request("/v1/feedback","OPTIONS",null,SITE_ORIGIN),env);
  assert.equal(allowed.status,200);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"),SITE_ORIGIN);
  const denied=await worker.fetch(request("/v1/feedback","OPTIONS",null,"https://bad.example"),env);
  assert.equal(denied.status,403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"),null);
});
test("anonymous calls cannot access moderation queue",async()=>{
  const response=await worker.fetch(request("/v1/admin/feedback"),env);
  assert.equal(response.status,401);
});
test("unknown endpoint is denied",async()=>{
  const response=await worker.fetch(request("/v1/account-export"),env);
  assert.equal(response.status,404);
});
