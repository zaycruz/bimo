#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const config=JSON.parse(fs.readFileSync(process.env.MONOLITH_WORKER_CONFIG,"utf8"));
// One-shot crash injection for lifecycle tests. The test writes a JSON file
// {"point":"<name>"} at MONOLITH_CRASH_FILE before apply. The worker consumes
// the file at startup, so a restart replays without crashing again.
let crash=null;
const crashFile=process.env.MONOLITH_CRASH_FILE;
if(crashFile){
  try{crash=JSON.parse(fs.readFileSync(crashFile,"utf8")).point||null;fs.unlinkSync(crashFile)}catch{crash=null}
}
let seq=1;let request=null;let pendingTool=null;
const base=(type,payload,extra={})=>({protocol:"agent-worker/v1",direction:"worker_to_control",type,factory_gen:config.factory_gen,pod:config.pod.name,session:config.session,seq:seq++,...extra,payload});
const emit=v=>process.stdout.write(JSON.stringify(v)+"\n");
const emitAndExit=(v,code)=>{process.stdout.write(JSON.stringify(v)+"\n",()=>process.exit(code))};
const terminal=(status,payload,extra={})=>emit(base("terminal",{status,...payload},{request_id:request,...extra}));
if(crash==="before_hello")process.exit(42);
emit(base("hello",{engine:config.pod.engine,launch_fingerprint:config.launch_fingerprint}));
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{
  let f;try{f=JSON.parse(line)}catch{process.exit(64)}
  if(f.protocol!=="agent-worker/v1"||f.session!==config.session||f.pod!==config.pod.name)process.exit(65);
  if(f.type==="work_request"){
    request=f.request_id;
    if(crash==="after_work_receipt")process.exit(42);
    if(crash==="malformed"){process.stdout.write("not-json\n");return}
    if(config.pod.capabilities.includes("pod.send_message")&&config.pod.destinations.includes(f.payload.from)){
      // after_tool_result_vary_id: the first run uses tool-<request> and crashes
      // after the tool result; the replay (marker file present) uses a different
      // tool_call_id to prove the effect key is independent of the worker-chosen id.
      const varyMarker=process.env.MONOLITH_VARY_MARKER;
      const isReplay=varyMarker&&fs.existsSync(varyMarker);
      pendingTool=isReplay?`tool-${request}-replay`:`tool-${request}`;
      emit(base("tool_call",{name:"pod.send_message",arguments:{to:f.payload.from,kind:"work.completed",payload:`completed: ${f.payload.body}`}}, {request_id:request,tool_call_id:pendingTool}));
    } else if(crash==="after_terminal_sent"){emitAndExit(base("terminal",{status:"success",output:`completed: ${f.payload.body}`},{request_id:request}),42)}
    else terminal("success",{output:`completed: ${f.payload.body}`});
  } else if(f.type==="tool_result"&&f.tool_call_id===pendingTool){
    if(crash==="after_tool_result")process.exit(42);
    if(crash==="after_tool_result_vary_id"){
      const varyMarker=process.env.MONOLITH_VARY_MARKER;
      if(varyMarker&&fs.existsSync(varyMarker)){
        // Replay with a different tool_call_id: complete normally.
        terminal("success",{output:"fixture completed","tool_result":f.payload});
      } else {
        // First run: record the marker and crash after the tool result.
        if(varyMarker)fs.writeFileSync(varyMarker,"1");
        process.exit(42);
      }
      pendingTool=null;
      return;
    }
    if(crash==="after_terminal_sent"){emitAndExit(base("terminal",{status:"success",output:"fixture completed","tool_result":f.payload},{request_id:request}),42)}
    else terminal("success",{output:"fixture completed","tool_result":f.payload});
    pendingTool=null;
  }
  else if(f.type==="cancel"){emit(base("cancel_ack",{status:"cancelled"},{request_id:f.request_id}));emit(base("terminal",{status:"cancelled"},{request_id:f.request_id}))}
  else if(f.type==="shutdown"){emit(base("shutdown_ack",{status:"ok"}));process.exit(0)}
});
