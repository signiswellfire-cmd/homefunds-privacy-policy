import assert from "node:assert/strict";
import {test} from "node:test";
import worker from "../src/index.js";

const ORIGIN="https://homefunds.signiswellfire.com";
const BASE="https://feedback-api.signiswellfire.com";
const ID="178f05f5-8479-4274-a761-40fcc28eb813";
const CID="1f2a3b4c-1111-4444-aaaa-123456789abc";
const now=() => Math.floor(Date.now()/1000);
function envFor({feedbackStatus="published", parentStatus="published"}={}){
  const queries=[];
  const env={
    SITE_ORIGIN:ORIGIN,
    TURNSTILE_HOSTNAME:"homefunds.signiswellfire.com",
    TURNSTILE_SECRET:"test-turnstile-secret",
    VOTER_COOKIE_SECRET:"test-voter-secret",
    RATE_LIMIT_SECRET:"test-rate-secret",
    ADMIN_TOKEN:"admin-token-more-than-twenty-characters-for-unit-testing",
    DB:{
      prepare(sql) {
        const q={sql,binds:[]};queries.push(q);
        return {
          bind(...args){q.binds=args;return this;},
          async run(){return{meta:{changes:1}};},
          async first(){
            if(sql.includes("SELECT status FROM feedback WHERE id=?")) return {status:feedbackStatus};
            if(sql.includes("SELECT id, feedback_id, parent_id, status FROM feedback_comments"))
              return {id:CID,feedback_id:ID,parent_id:null,status:parentStatus};
            if(sql.includes("SELECT status FROM feedback_comments WHERE feedback_id=?"))
              return {status:"published"};
            return null;
          },
          async all(){return{results:[]};}
        };
      }
    }
  };
  return {env,queries};
}
function request(path,{method="GET", origin=ORIGIN,body=null, token=null, cookie=null}={}){
  const headers={};
  if(origin)headers.Origin=origin;
  if(body!==null)headers["Content-Type"]="application/json";
  if(token)headers.Authorization="Bearer "+token;
  if(cookie)headers.Cookie=cookie;
  return new Request(BASE+path,{method,headers,...(body!==null?{body:JSON.stringify(body)}:{})});
}
const commentData={
  body:"Please add a clearer monthly savings progress screen.",
  displayName:"Community tester",
  acceptedTerms:true,
  turnstileToken:"fake-test-token-for-unit-testing"
};
async function verifyWithTurnstile(callback){
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    success:true,hostname:"homefunds.signiswellfire.com",action:"feedback"
  }),{status:200,headers:{"Content-Type":"application/json"}});
  try{return await callback();}finally{globalThis.fetch=original;}
}
test("user comments remain pending, not published without moderation",async()=>{
  await verifyWithTurnstile(async()=>{
    const {env,queries}=envFor();
    const result=await worker.fetch(request("/v1/feedback/"+ID+"/comments",{
      method:"POST",body:commentData
    }),env);
    assert.equal(result.status,202);
    assert.equal((await result.json()).status,"pending");
    const q=queries.find(x=>x.sql.includes("INSERT INTO feedback_comments"));
    assert.ok(q);
    assert.ok(q.sql.includes("'pending'"));
    assert.ok(q.sql.includes("is_admin"));
    assert.ok(q.binds.includes("Community tester"));
  });
});
test("comment posting demands Terms consent",async()=>{
  const {env}=envFor();
  const result=await worker.fetch(request("/v1/feedback/"+ID+"/comments",{
    method:"POST",body:{...commentData,acceptedTerms:false}
  }),env);
  assert.equal(result.status,400);
});
test("HTML comments remain inert text; direct links and email addresses are disallowed",async()=>{
  const {env}=envFor();
  const bad=await worker.fetch(request("/v1/feedback/"+ID+"/comments",{
    method:"POST",body:{...commentData,body:"Please see https://private.example/records"}
  }),env);
  assert.equal(bad.status,400);
});
test("no comments are visible when a suggestion is still pending",async()=>{
  const {env}=envFor({feedbackStatus:"pending"});
  const result=await worker.fetch(request("/v1/feedback/"+ID+"/comments"),env);
  assert.equal(result.status,404);
});
test("public comments query includes only approved comments and never hidden feedback names",async()=>{
  const {env,queries}=envFor();
  const result=await worker.fetch(request("/v1/feedback/"+ID+"/comments"),env);
  assert.equal(result.status,200);
  const q=queries.find(x=>x.sql.includes("FROM feedback_comments WHERE feedback_id=?"));
  assert.ok(q.sql.includes("status='published'"));
  assert.ok(!q.sql.includes("submitter_name"));
});
test("admin can publish an official reply without Turnstile",async()=>{
  const {env,queries}=envFor();
  const result=await worker.fetch(request("/v1/admin/feedback/"+ID+"/comments",{
    method:"POST",body:{body:"HomeFunds is planning this improvement."},
    token:env.ADMIN_TOKEN,origin:null
  }),env);
  assert.equal(result.status,201);
  const resultBody=await result.json();
  assert.equal(resultBody.isAdmin,true);
  const q=queries.find(x=>x.sql.includes("INSERT INTO feedback_comments"));
  assert.ok(q.sql.includes("'homefunds-team'"));
  assert.ok(q.sql.includes("'published'"));
});
test("unverified visitors cannot publish official replies or delete comments",async()=>{
  const {env,queries}=envFor();
  const post=await worker.fetch(request("/v1/admin/feedback/"+ID+"/comments",{
    method:"POST",body:{body:"Fake official response"}
  }),env);
  const del=await worker.fetch(request("/v1/admin/comments/"+CID,{method:"DELETE"}),env);
  assert.equal(post.status,401);
  assert.equal(del.status,401);
  assert.equal(queries.some(q=>q.sql.includes("DELETE FROM feedback_comments")),false);
});
test("admin can approve and remove comments after verification",async()=>{
  const {env,queries}=envFor();
  const approve=await worker.fetch(request("/v1/admin/comments/"+CID,{
    method:"PUT",body:{status:"published"},origin:null,token:env.ADMIN_TOKEN
  }),env);
  assert.equal(approve.status,200);
  assert.ok(queries.some(q=>q.sql.includes("UPDATE feedback_comments SET status")));
  const remove=await worker.fetch(request("/v1/admin/comments/"+CID,{
    method:"DELETE",origin:null,token:env.ADMIN_TOKEN
  }),env);
  assert.equal(remove.status,200);
});
test("regular visitors cannot comment on an unpublished suggestion",async()=>{
  const {env}=envFor({feedbackStatus:"hidden"});
  const result=await worker.fetch(request("/v1/feedback/"+ID+"/comments",{
    method:"POST",body:commentData
  }),env);
  assert.equal(result.status,404);
});
test("comment reports enter private moderator review, not public comments",async()=>{
  await verifyWithTurnstile(async()=>{
    const {env,queries}=envFor();
    const result=await worker.fetch(request("/v1/feedback/"+ID+"/comments/"+CID+"/report",{
      method:"POST",body:{reason:"abuse",turnstileToken:"test-token-for-report"}
    }),env);
    assert.equal(result.status,202);
    assert.ok(queries.some(q=>q.sql.includes("INSERT OR IGNORE INTO feedback_comment_reports")));
  });
});
test("community members cannot impersonate HomeFunds Team",async()=>{
  const {env}=envFor();
  const result=await worker.fetch(request("/v1/feedback/"+ID+"/comments",{
    method:"POST",body:{...commentData,displayName:"HomeFunds Team"}
  }),env);
  assert.equal(result.status,400);
});
test("the public API will reject requests from untrusted origins",async()=>{
  const {env}=envFor();
  const result=await worker.fetch(request("/v1/feedback/"+ID+"/comments",{
    method:"POST",origin:"https://attacker.example",body:commentData
  }),env);
  assert.equal(result.status,403);
});
