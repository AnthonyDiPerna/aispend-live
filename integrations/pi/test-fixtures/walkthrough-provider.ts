// Offline walkthrough fixture. Every model response below is deterministic.
import {createProvider,createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {appendFileSync} from 'node:fs';
export default function fixture(pi:any){
  let contextTurns=0,loopTurns=0;
  for(const provider of ['claude-code','openai']){
    const stream=(model:any)=>{
      const result=createAssistantMessageEventStream();
      queueMicrotask(()=>{
        if(process.env.AI_SPEND_FIXTURE_COUNT)appendFileSync(process.env.AI_SPEND_FIXTURE_COUNT,provider+'\n');
        const looping=loopTurns>0;
        if(looping)loopTurns--;
        const contextual=contextTurns>0,large=contextTurns===1,turn=contextTurns;
        if(contextual)contextTurns--;
        const message:any={role:'assistant',api:'guard-walkthrough',provider,model:model.id,timestamp:Date.now(),
          content:contextual||looping?[{type:'toolCall',id:'fixture-'+Date.now(),name:'bash',arguments:{command:looping?'repeat-offline-search':'offline-context-chunk-'+turn}}]:[{type:'text',text:'Fixture progress: reset planner updated. Next, verify the fresh-reading requirement. No real model was called.'}],
          stopReason:contextual||looping?'toolUse':'stop',usage:{input:large?170000:500,output:40,cacheRead:0,cacheWrite:0,totalTokens:large?170040:540,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
        result.push({type:'start',partial:message});result.push({type:'done',reason:message.stopReason,message});result.end(message);
      });return result;
    };
    pi.registerProvider(createProvider({id:provider,name:'OFFLINE WALKTHROUGH',baseUrl:'test://guard',
      auth:{apiKey:{name:'Fixture',check:async()=>({type:'oauth',source:'fixture'}),resolve:async()=>({auth:{apiKey:'fixture'},source:'fixture'})},
        oauth:{name:'Fixture',isSubscription:true,login:async()=>{throw Error('No real login');},refresh:async()=>{throw Error('No real login');},toAuth:async()=>({apiKey:'fixture'})}},
      models:[{id:'walkthrough-balanced',name:'Offline balanced fixture',provider,api:'guard-walkthrough',baseUrl:'test://guard',reasoning:false,input:['text'],contextWindow:200000,maxTokens:4096,cost:{input:3,output:15,cacheRead:.3,cacheWrite:3.75}}],api:{stream,streamSimple:stream}} as any));
  }
  pi.registerTool({name:'bash',label:'Offline history fixture',description:'Return synthetic context without running a shell',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']},async execute(){return {content:[{type:'text',text:'Completed fixture exploration.\n'+'.'.repeat(40000)+'\nNext: verify the reset edge case.'}],details:{}};}});
  pi.registerCommand('fixture-context',{description:'Offline recording only: build a compactable fixture history',handler:async()=>{contextTurns=8;pi.sendUserMessage('Complete the bounded context checkpoint fixture.');}});
  pi.registerCommand('fixture-loop',{description:'Offline recording only: exercise a repeated search and repair',handler:async()=>{loopTurns=3;pi.sendUserMessage('Complete the repeated-search fixture.');}});
}
