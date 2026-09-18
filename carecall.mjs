import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const userHash = user => createHash('sha256').update(user).digest('hex');
const response = (statusCode, body) => ({statusCode, headers:{'content-type':'application/json','cache-control':'no-store'}, body:JSON.stringify(body)});
function equal(a,b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0
    && timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
}
export function callMessage(id, text) {
  return {type:'template',altText:text,template:{type:'buttons',text,actions:[{
    type:'postback',label:'確認しました',data:`carecall:ack:${id}`,
    displayText:'確認ボタンを押しました（確認結果は処理中です）'
  }]}};
}
export function publicState(record, duplicate=false) {
  return {ok:true,event_id:record.id,duplicate,
    status:record.acknowledgedAt ? 'acknowledged' : record.delivery === 'accepted' ? 'accepted_by_line'
      : record.delivery === 'pending' ? 'pending' : 'legacy_delivery_unknown',
    acknowledged_at:record.acknowledgedAt ?? null};
}
export function createCareCallHandler({config,store,line,now=()=>Date.now(),uuid=randomUUID}) {
  return async event => {
    const path=event.rawPath ?? event.requestContext?.http?.path;
    if (path !== '/carecall' && !path?.startsWith('/carecall/') && path !== '/line/carecall/webhook') return null;
    const method=event.requestContext?.http?.method;
    const headers=Object.fromEntries(Object.entries(event.headers??{}).map(([k,v])=>[k.toLowerCase(),v]));
    if (!config.enabled || !config.deviceSecret || !config.owner || !config.channelSecret || !config.bot
        || !config.message || config.message.length>160) return response(503,{ok:false,error:'care call disabled'});
    const raw=Buffer.from(event.body??'',event.isBase64Encoded?'base64':'utf8');
    if(raw.length>65536) return response(413,{ok:false});
    try {
      if(path === '/line/carecall/webhook') {
        if(method !== 'POST') return response(405,{ok:false});
        const signature=createHmac('sha256',config.channelSecret).update(raw).digest('base64');
        if(!equal(headers['x-line-signature'],signature))return response(401,{ok:false});
        let body;try{body=JSON.parse(raw);}catch{return response(400,{ok:false});}
        if(body?.destination!==config.bot || !Array.isArray(body.events) || body.events.length>100)return response(400,{ok:false});
        let failed=false, confirmed=0;
        for(const item of body.events) {
          if(item?.type!=='postback' || item.mode!=='active' || item.source?.type!=='user' || item.source.userId!==config.owner)continue;
          const data=item.postback?.data;
          if(typeof data!=='string' || !data.startsWith('carecall:ack:'))continue;
          const id=data.slice('carecall:ack:'.length);if(!ID.test(id))continue;
          const existing=await store.get(id);
          if(!existing || existing.ownerHash!==userHash(config.owner))continue;
          const record=await store.ack(id,new Date(now()).toISOString(),existing.ownerHash);
          if(!record?.acknowledgedAt){failed=true;continue;}
          confirmed++;
          // Reply failure must not undo durable confirmation or resend the call.
          if(typeof item.replyToken==='string' && item.replyToken) {
            try{await line.reply(item.replyToken,'確認を記録しました。電話などで状況を確かめてください。');}
            catch{ /* caller can still obtain durable confirmation */ }
          }
        }
        return response(failed?503:200,{ok:!failed,confirmed});
      }
      if(!equal(headers['x-carecall-token'],config.deviceSecret))return response(401,{ok:false});
      if(path.startsWith('/carecall/') && method==='GET') {
        const id=path.slice('/carecall/'.length);if(!ID.test(id))return response(400,{ok:false});
        const record=await store.get(id);
        if(!record || record.ownerHash!==userHash(config.owner))return response(404,{ok:false});
        return response(200,publicState(record));
      }
      if(path!=='/carecall' || method!=='POST')return response(405,{ok:false});
      let body;try{body=JSON.parse(raw);}catch{return response(400,{ok:false});}
      if(!body || typeof body.event_id!=='string' || !ID.test(body.event_id) || body.event!=='call' || body.urgency!=='normal' || body.source!=='button')return response(400,{ok:false});
      const id=body.event_id;
      const fresh={id,ownerHash:userHash(config.owner),createdAt:new Date(now()).toISOString(),delivery:'pending',retryKey:uuid()};
      const claimed=await store.create(fresh);
      if(!claimed) {
        const existing=await store.get(id);
        if(!existing || existing.ownerHash!==fresh.ownerHash)return response(409,{ok:false});
        // Never repeat a push on a duplicate or ambiguous earlier attempt.
        return response(202,publicState(existing,true));
      }
      let delivery='unknown';
      try{await line.push(config.owner,callMessage(id,config.message),fresh.retryKey);delivery='accepted';}catch{/* uncertain delivery */}
      const record=await store.delivery(id,delivery);
      return response(delivery==='accepted'?200:202,publicState(record));
    } catch {
      // Do not log payloads, header secrets, LINE response bodies or user identifiers.
      return response(503,{ok:false,error:'care call unavailable'});
    }
  };
}

export function createDynamoStore({client,GetCommand,PutCommand,UpdateCommand,table}) {
  const send=command=>client.send(command,{abortSignal:AbortSignal.timeout(5000)});
  return {
    async get(id){return (await send(new GetCommand({TableName:table,Key:{id},ConsistentRead:true}))).Item;},
    async create(record){
      try{await send(new PutCommand({TableName:table,Item:record,ConditionExpression:'attribute_not_exists(id)'}));return true;}
      catch(error){if(error.name==='ConditionalCheckFailedException')return false;throw error;}
    },
    async delivery(id,value){return (await send(new UpdateCommand({TableName:table,Key:{id},
      ConditionExpression:'attribute_exists(id)',UpdateExpression:'SET delivery = :value',
      ExpressionAttributeValues:{':value':value},ReturnValues:'ALL_NEW'}))).Attributes;},
    async ack(id,at,ownerHash){return (await send(new UpdateCommand({TableName:table,Key:{id},
      ConditionExpression:'attribute_exists(id) AND ownerHash = :owner',
      UpdateExpression:'SET acknowledgedAt = if_not_exists(acknowledgedAt, :at)',
      ExpressionAttributeValues:{':owner':ownerHash,':at':at},ReturnValues:'ALL_NEW'}))).Attributes;}
  };
}

export function createLineTransport({token,request=fetch}) {
  async function send(path,payload,headers={}) {
    const result=await request(`https://api.line.me/v2/bot/message/${path}`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{'content-type':'application/json',authorization:`Bearer ${token}`,...headers},body:JSON.stringify(payload)});
    const accepted=result.ok || (path==='push' && result.status===409 && result.headers.get('x-line-accepted-request-id'));
    await result.body?.cancel();
    if(!accepted)throw Error('LINE request not confirmed');
  }
  return {
    push:(to,message,key)=>send('push',{to,messages:[message]},{'x-line-retry-key':key}),
    reply:(replyToken,text)=>send('reply',{replyToken,messages:[{type:'text',text}]})
  };
}

let runtime;
export async function handleCareCall(event) {
  const path=event.rawPath??event.requestContext?.http?.path;
  if(path!=='/carecall' && !path?.startsWith('/carecall/') && path!=='/line/carecall/webhook')return null;
  const env=process.env;
  if(env.CARECALL_ENABLED!=='1' || !env.CARECALL_TABLE || !env.LINE_CHANNEL_ACCESS_TOKEN)return response(503,{ok:false,error:'care call disabled'});
  try {
    if(!runtime) {
      const [{DynamoDBClient},{DynamoDBDocumentClient,GetCommand,PutCommand,UpdateCommand}]=await Promise.all([
        import('@aws-sdk/client-dynamodb'),import('@aws-sdk/lib-dynamodb')]);
      const client=DynamoDBDocumentClient.from(new DynamoDBClient({maxAttempts:2}));
      runtime=createCareCallHandler({config:{enabled:true,deviceSecret:env.CARECALL_DEVICE_SECRET,
        owner:env.LINE_USER_ID,bot:env.LINE_BOT_USER_ID,channelSecret:env.LINE_CHANNEL_SECRET,message:env.CARECALL_MESSAGE},
        store:createDynamoStore({client,GetCommand,PutCommand,UpdateCommand,table:env.CARECALL_TABLE}),
        line:createLineTransport({token:env.LINE_CHANNEL_ACCESS_TOKEN})});
    }
    return await runtime(event);
  } catch {return response(503,{ok:false,error:'care call unavailable'});}
}
