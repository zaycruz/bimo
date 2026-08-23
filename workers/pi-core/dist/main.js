import fs from "node:fs";
import readline from "node:readline";
import { HostToolBridge, parseFrame, VERSION } from "./protocol.js";
import { createPiAgent } from "./pi-agent.js";
export async function run(factory = createPiAgent) {
    const configPath = process.env.MONOLITH_WORKER_CONFIG;
    if (!configPath)
        throw new Error("MONOLITH_WORKER_CONFIG is required");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    let workerSeq = 1;
    let controlSeq = 0;
    let activeRequest;
    let abort;
    let agent;
    const emit = (type, payload, extra = {}) => {
        process.stdout.write(JSON.stringify({
            protocol: VERSION,
            direction: "worker_to_control",
            type,
            factory_gen: cfg.factory_gen,
            pod: cfg.pod.name,
            session: cfg.session,
            seq: workerSeq++,
            ...extra,
            payload,
        }) + "\n");
    };
    const bridge = new HostToolBridge((name, args, id) => {
        if (!activeRequest)
            throw new Error("no_active_request");
        emit("tool_call", { name, arguments: args }, { request_id: activeRequest, tool_call_id: id });
    });
    emit("hello", { engine: cfg.pod.engine, launch_fingerprint: cfg.launch_fingerprint });
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
        const frame = parseFrame(line, cfg.pod.max_frame_bytes);
        if (frame.factory_gen !== cfg.factory_gen || frame.session !== cfg.session ||
            frame.pod !== cfg.pod.name || frame.seq !== ++controlSeq)
            throw new Error("stale_frame");
        if (frame.type === "hello_ack") {
            if (agent)
                throw new Error("duplicate_hello_ack");
            agent = await factory(cfg.pod.config);
        }
        else if (frame.type === "work_request") {
            if (!agent)
                throw new Error("work_before_handshake");
            if (activeRequest)
                throw new Error("concurrent_work");
            activeRequest = frame.request_id;
            abort = new AbortController();
            const requestId = activeRequest;
            void agent.run(String(frame.payload.body), bridge, abort.signal).then(async (output) => {
                await agent.waitForIdle();
                emit("terminal", { status: "success", output }, { request_id: requestId });
            }).catch(() => {
                emit("terminal", {
                    status: abort?.signal.aborted ? "cancelled" : "failed",
                    code: "agent_error",
                    message: abort?.signal.aborted ? "turn cancelled" : "agent execution failed",
                }, { request_id: requestId });
            }).finally(() => {
                activeRequest = undefined;
                abort = undefined;
            });
        }
        else if (frame.type === "tool_result") {
            if (frame.request_id !== activeRequest || !frame.tool_call_id)
                throw new Error("mismatched_tool_result");
            bridge.accept(frame.tool_call_id, frame.payload);
        }
        else if (frame.type === "cancel") {
            abort?.abort();
            bridge.failAll("cancelled");
            if (agent)
                await agent.waitForIdle();
            emit("cancel_ack", { status: "cancelled" }, { request_id: frame.request_id });
        }
        else if (frame.type === "shutdown") {
            abort?.abort();
            bridge.failAll("shutdown");
            if (agent)
                await agent.waitForIdle();
            emit("shutdown_ack", { status: "ok" });
            break;
        }
        else {
            throw new Error("illegal_control_frame");
        }
    }
}
if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch(() => {
        process.stderr.write("worker_error: agent execution failed\n");
        process.exitCode = 1;
    });
}
