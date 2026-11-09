// Test-only provider: no network calls, real accounts, or shell execution.
import {createProvider,createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {appendFileSync} from 'node:fs';

export default function fixture(pi:any) {
  const api=process.env.AI_SPEND_FIXTURE_API==='1';
  const provider=api?'guard-api-fixture':'claude-code';
  let calls=0;
  const stream=(model:any,_context:any,_options:any)=>{
    const result=createAssistantMessageEventStream();
    queueMicrotask(()=>{
      calls++;
      if(process.env.AI_SPEND_FIXTURE_COUNT)appendFileSync(process.env.AI_SPEND_FIXTURE_COUNT,'request\n');
      const compact=process.env.AI_SPEND_FIXTURE_COMPACT==='1';
      const recovered=process.env.AI_SPEND_FIXTURE_RECOVER==='1' && JSON.stringify(_context.messages).includes('Guard automatic recovery:');
      const loop=!recovered && (process.env.AI_SPEND_FIXTURE_LOOP==='1' || (compact && calls<=8));
      const message:any={role:'assistant',api:'guard-fixture',provider,model:model.id,timestamp:Date.now(),
        content:loop?[{type:'toolCall',id:'fixture-'+Date.now(),name:'bash',arguments:{command:compact?'fixture-'+calls:'fixture'}}]:[{type:'text',text:'Guard fixture completed.'}],
        stopReason:loop?'toolUse':'stop',usage:{input:compact && calls===8?170000:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:compact && calls===8?170010:110,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:api?.001:0}}};
      result.push({type:'start',partial:message});
      result.push({type:'done',reason:message.stopReason,message});result.end(message);
    });
    return result;
  };
  pi.registerProvider(createProvider({id:provider,name:'TEST ONLY',baseUrl:'test://guard',
    auth:{apiKey:{name:'Fixture',check:async()=>({type:api?'api_key':'oauth',source:'fixture'}),resolve:async()=>({auth:{apiKey:'fixture'},source:'fixture'})},
      oauth:{name:'Fixture',isSubscription:true,login:async()=>{throw Error('No real login');},refresh:async()=>{throw Error('No real login');},toAuth:async()=>({apiKey:'fixture'})}},
    models:[{id:'guard-fixture',name:'Guard fixture',provider,baseUrl:'test://guard',api:'guard-fixture',reasoning:false,input:['text'],contextWindow:200000,maxTokens:1000,cost:{input:3,output:15,cacheRead:.3,cacheWrite:3.75}}],
    api:{stream,streamSimple:stream},
  } as any));
  pi.registerTool({name:'bash',label:'Fixture output',description:'Return test output without executing anything',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']},
    async execute(){if(process.env.AI_SPEND_FIXTURE_COUNT)appendFileSync(process.env.AI_SPEND_FIXTURE_COUNT+'.tools','tool\n');return {content:[{type:'text',text:'START\n'+'.'.repeat(40000)+'\nEND'}],details:{}};}});
}
