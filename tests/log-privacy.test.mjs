import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {format} from 'node:util';
const PRIVATE='SYNTHETIC_PRIVATE_VALUE';
Object.assign(process.env,{REPORT_WEBHOOK_SECRET:'synthetic-report',EVENT_WEBHOOK_SECRET:'synthetic-event',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-line',LINE_USER_ID:'synthetic-owner',CARECALL_ENABLED:'0'});
let attempts=0;
https.request=()=>{attempts++;const req=new EventEmitter();req.write=()=>{};req.end=()=>queueMicrotask(()=>req.emit('error',new Error(PRIVATE)));return req;};
globalThis.fetch=()=>{throw Error('external network forbidden')};
const {handler}=await import(process.env.TEST_HANDLER_URL ?? '../index.mjs');
const original={log:console.log,warn:console.warn,error:console.error};
async function capture(event,check){
 const lines=[];for(const k of Object.keys(original))console[k]=(...args)=>lines.push(format(...args));
 let result;try{result=await handler(event);}finally{Object.assign(console,original);}
 check(result);assert.ok(lines.length>0,'keep operational diagnostics');
 assert.equal(lines.join('\n').includes(PRIVATE),false,'request values and errors must not reach logs');
}
const request=(body,headers={})=>({rawPath:'/',requestContext:{http:{method:'POST'}},headers,body:JSON.stringify(body)});
test('HTTP headers, query and report body remain private',async()=>{
 await capture({...request({private:PRIVATE},{authorization:PRIVATE,'x-report-secret':PRIVATE}),queryStringParameters:{secret:PRIVATE}},r=>assert.equal(r.statusCode,401));
});
test('malformed Alexa request does not log its context',async()=>{
 await capture({session:{user:{userId:PRIVATE}},private:PRIVATE},r=>assert.match(r.response.outputSpeech.text,/リクエスト/));
});
test('session-end reason is not copied to logs',async()=>{
 await capture({request:{type:'SessionEndedRequest',reason:PRIVATE}},r=>assert.deepEqual(r,{}));
});
test('Alexa slots and transport errors stay private while failure is returned',async()=>{
 await capture({request:{type:'IntentRequest',dialogState:'COMPLETED',intent:{name:'LineMessageIntent',slots:{message:{value:PRIVATE}}}}},r=>assert.match(r.response.outputSpeech.text,/失敗/));
});
test('report push failure keeps provider error details private',async()=>{
 const body={type:'daily_summary',date:'2025-01-01',pace_sessions:0,pace_duration_s:0,pace_distance_m:0,pace_beats:0,reminders:0,checkins:0,nurse_calls_ok:0,nurse_calls_failed:0,commands:0,generated_at:'2025-01-01T00:00:00Z'};
 await capture(request(body,{'x-report-secret':'synthetic-report'}),r=>assert.equal(r.statusCode,502));
});
test('event push failure keeps provider error details private',async()=>{
 await capture(request({type:'duck_offline',ts:'2025-01-01T00:00:00Z',source:'duckbridge',detail:{source:'synthetic'}}, {'x-event-secret':'synthetic-event'}),r=>assert.equal(r.statusCode,502));
 assert.equal(attempts,3,'synthetic LINE failures exercised without real network');
});
