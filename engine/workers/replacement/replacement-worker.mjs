#!/usr/bin/env node
// Replacement-harness fixture: a deliberately different worker implementation
// that speaks the same agent-worker/v1 JSONL protocol. It proves Rust behavior
// is unchanged when the adapter changes (engine neutrality, R6).
import fs from "node:fs";
import readline from "node:readline";
const config=JSON.parse(fs.readFileSync(process.env.MONOLITH_WORKER_CONFIG,"utf8"));
let seq=1;
const base=(type,payload,extra={})=>({protocol:"agent-worker/v1",direction:"worker_to_control",type,factory_gen:config.factory_gen,pod:config.pod.name,session:config.session,seq:seq++,...extra,payload});
const emit=v=>process.stdout.write(JSON.stringify(v)+"\n");
emit(base("hello",{engine:config.pod.engine,launch_fingerprint:config.launch_fingerprint}));
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{
  let f;try{f=JSON.parse(line)}catch{process.exit(64)}
  if(f.protocol!=="agent-worker/v1"||f.session!==config.session||f.pod!==config.pod.name)process.exit(65);
  if(f.type==="work_request"){
    emit(base("terminal",{status:"success",output:`replacement completed: ${f.payload.body}`},{request_id:f.request_id}));
  } else if(f.type==="cancel"){
    emit(base("cancel_ack",{status:"cancelled"},{request_id:f.request_id}));
    emit(base("terminal",{status:"cancelled"},{request_id:f.request_id}));
  } else if(f.type==="shutdown"){
    emit(base("shutdown_ack",{status:"ok"}));
    process.exit(0);
  }
});
