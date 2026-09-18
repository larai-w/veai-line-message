import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createCareCallHandler,createLineTransport,createDynamoStore} from '../carecall.mjs';
import {handler as combined} from '../index.mjs';

const config={enabled:true,deviceSecret:'dummy-device',owner:'dummy-owner',bot:'dummy-bot',channelSecret:'dummy-channel',message:'テスト用の呼び出しです。'};
function setup(overrides={}) {
  const records=new Map(), pushes=[], replies=[];
  const store={
    get:async id=>records.get(id),
    create:async r=>{if(records.has(r.id))return false;records.set(r.id,{...r});return true;},
    delivery:async(id,value)=>{records.get(id).delivery=value;return records.get(id);},
    ack:async(id,at)=>{records.get(id).acknowledgedAt??=at;return records.get(id);}
  };
  const line={push:async(...args)=>pushes.push(args),reply:async(...args)=>replies.push(args)};
  const handle=createCareCallHandler({config,store,line,uuid:()=> 'test-retry-key',...overrides});
  return {handle,records,pushes,replies,store,line};
}
function request(path,body,headers={'x-carecall-token':config.deviceSecret},method='POST') {
  return {rawPath:path,requestContext:{http:{path,method}},headers,body:JSON.stringify(body)};
}
const call=id=>request('/carecall',{event_id:id,event:'call',urgency:'normal',source:'button'});
function webhook(id,{owner=config.owner,signature=true,base64=false}={}) {
  const event=request('/line/carecall/webhook',{destination:config.bot,events:[{
    type:'postback',mode:'active',source:{type:'user',userId:owner},replyToken:'dummy-reply',postback:{data:`carecall:ack:${id}`}
  }]},{});
  event.headers['x-line-signature']=signature?createHmac('sha256',config.channelSecret).update(event.body).digest('base64'):'invalid';
  if(base64){event.body=Buffer.from(event.body).toString('base64');event.isBase64Encoded=true;}
  return event;
}
const body=r=>JSON.parse(r.body);
test('full call, button confirmation and authenticated status lookup',async()=>{
  const h=setup();assert.equal(body(await h.handle(call('one'))).status,'accepted_by_line');
  assert.equal(h.pushes[0][0],config.owner);assert.equal(h.pushes[0][2],'test-retry-key');
  assert.equal(h.pushes[0][1].template.actions[0].data,'carecall:ack:one');
  assert.equal(body(await h.handle(webhook('one',{base64:true}))).confirmed,1);
  const result=body(await h.handle(request('/carecall/one',undefined,undefined,'GET')));
  assert.equal(result.status,'acknowledged');assert.ok(result.acknowledged_at);
  assert.equal(h.replies.length,1);
});
test('simultaneous duplicate calls push only once',async()=>{
  const h=setup();await Promise.all([h.handle(call('one')),h.handle(call('one'))]);
  assert.equal(h.pushes.length,1);
  assert.equal(body(await h.handle(call('one'))).duplicate,true);
});
test('duplicate acknowledgement keeps original time',async()=>{
  const h=setup();await h.handle(call('one'));await h.handle(webhook('one'));
  const at=h.records.get('one').acknowledgedAt;
  await h.handle(webhook('one'));assert.equal(h.records.get('one').acknowledgedAt,at);
});
test('wrong signature and wrong person cannot acknowledge',async()=>{
  const h=setup();await h.handle(call('one'));
  assert.equal((await h.handle(webhook('one',{signature:false}))).statusCode,401);
  assert.equal(body(await h.handle(webhook('one',{owner:'someone-else'}))).confirmed,0);
  assert.equal(h.records.get('one').acknowledgedAt,undefined);
});
test('unknown call is ignored, empty LINE verification works',async()=>{
  const h=setup();assert.equal(body(await h.handle(webhook('missing'))).confirmed,0);
  const e=request('/line/carecall/webhook',{destination:config.bot,events:[]},{});
  e.headers['x-line-signature']=createHmac('sha256',config.channelSecret).update(e.body).digest('base64');
  assert.equal((await h.handle(e)).statusCode,200);
});
test('storage failure prevents sending',async()=>{
  const h=setup();h.store.create=async()=>{throw Error('disk');};
  assert.equal((await h.handle(call('one'))).statusCode,503);assert.equal(h.pushes.length,0);
});
test('ambiguous LINE failure does not automatically repeat push',async()=>{
  const h=setup();let attempts=0;h.line.push=async()=>{attempts++;throw Error('timeout');};
  assert.equal(body(await h.handle(call('one'))).status,'legacy_delivery_unknown');
  await h.handle(call('one'));assert.equal(attempts,1);
});
test('reply failure does not undo saved confirmation',async()=>{
  const h=setup();h.line.reply=async()=>{throw Error('timeout');};await h.handle(call('one'));
  assert.equal((await h.handle(webhook('one'))).statusCode,200);
  assert.ok(h.records.get('one').acknowledgedAt);
});
test('new routes fail closed before existing event logging, legacy Alexa launch preserved',async()=>{
  const old=process.env.CARECALL_ENABLED;delete process.env.CARECALL_ENABLED;
  try{
    assert.equal((await combined(call('one'))).statusCode,503);
    assert.equal((await combined({request:{type:'LaunchRequest'}})).response.shouldEndSession,false);
  }finally{if(old!==undefined)process.env.CARECALL_ENABLED=old;}
});
test('missing secret, bad method, wrong auth and malformed identifiers are rejected',async()=>{
  const disabled=setup({config:{...config,channelSecret:''}});
  assert.equal((await disabled.handle(call('one'))).statusCode,503);
  const h=setup();const bad=call('one');bad.headers={};assert.equal((await h.handle(bad)).statusCode,401);
  assert.equal((await h.handle(call(['one']))).statusCode,400);
  assert.equal((await h.handle(request('/carecall',{},undefined,'DELETE'))).statusCode,405);
  assert.equal((await h.handle(request('/carecall/../x',{},undefined,'GET'))).statusCode,400);
  assert.equal(h.pushes.length,0);
});
test('LINE transport uses bounded request, retry key and accepts deduplicated push',async()=>{
  const requests=[];
  const line=createLineTransport({token:'dummy-token',request:async(url,options)=>{
    requests.push({url,options});return {ok:false,status:409,headers:new Headers({'x-line-accepted-request-id':'dummy'}),body:{cancel:async()=>{}}};
  }});
  await line.push('owner',{type:'text',text:'test'},'retry');
  assert.equal(requests[0].options.headers['x-line-retry-key'],'retry');
  assert.ok(requests[0].options.signal);assert.equal(requests[0].options.redirect,'error');
  await assert.rejects(line.reply('reply','text'));
});
test('DynamoDB adapter uses conditional creation, consistent reads and immutable acknowledgement time',async()=>{
  class Command{constructor(input){this.input=input;}}
  const sent=[];
  const store=createDynamoStore({client:{send:async(c,options)=>{sent.push(c.input);assert.ok(options.abortSignal);return {Item:{id:'one'},Attributes:{id:'one'}};}},
    GetCommand:Command,PutCommand:Command,UpdateCommand:Command,table:'test'});
  await store.create({id:'one'});await store.get('one');await store.ack('one','time','hash');await store.delivery('one','accepted');
  assert.equal(sent[0].ConditionExpression,'attribute_not_exists(id)');assert.equal(sent[1].ConsistentRead,true);
  assert.match(sent[2].UpdateExpression,/if_not_exists/);assert.match(sent[2].ConditionExpression,/ownerHash/);
  assert.equal(sent[3].UpdateExpression,'SET delivery = :value');
});
