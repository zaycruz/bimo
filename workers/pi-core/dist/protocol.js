export const VERSION = "agent-worker/v1";
const FRAME_KEYS = {
    protocol: true,
    direction: true,
    type: true,
    factory_gen: true,
    pod: true,
    session: true,
    seq: true,
    request_id: true,
    tool_call_id: true,
    payload: true,
};
const CONTROL_TYPES = {
    hello_ack: true,
    work_request: true,
    tool_result: true,
    cancel: true,
    shutdown: true,
};
function assertRecord(value, error) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(error);
    }
}
function requiredString(frame, key) {
    const value = frame[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`invalid_frame_${key}`);
    }
    return value;
}
export function parseFrame(line, max = 65_536) {
    if (Buffer.byteLength(line, "utf8") > max) {
        throw new Error("frame_too_large");
    }
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new Error("invalid_frame_json");
    }
    assertRecord(value, "invalid_frame_object");
    if (Object.keys(value).some((key) => !FRAME_KEYS[key])) {
        throw new Error("invalid_frame_unknown_field");
    }
    if (value.protocol !== VERSION || value.direction !== "control_to_worker") {
        throw new Error("invalid_frame_identity");
    }
    const type = requiredString(value, "type");
    if (!CONTROL_TYPES[type]) {
        throw new Error("invalid_frame_type");
    }
    if (!Number.isSafeInteger(value.factory_gen) || value.factory_gen < 1) {
        throw new Error("invalid_frame_generation");
    }
    requiredString(value, "pod");
    requiredString(value, "session");
    if (!Number.isSafeInteger(value.seq) || value.seq < 1) {
        throw new Error("invalid_frame_sequence");
    }
    assertRecord(value.payload, "invalid_frame_payload");
    if (type === "work_request" || type === "cancel") {
        requiredString(value, "request_id");
    }
    if (type === "tool_result") {
        requiredString(value, "request_id");
        requiredString(value, "tool_call_id");
    }
    return value;
}
export function encodeFrame(frame) {
    return `${JSON.stringify(frame)}\n`;
}
export class HostToolBridge {
    send;
    pending = new Map();
    constructor(send) {
        this.send = send;
    }
    call(name, args, id) {
        if (!id || this.pending.has(id))
            return Promise.reject(new Error("duplicate_tool_call_id"));
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send(name, args, id);
        });
    }
    accept(id, result) {
        const pending = this.pending.get(id);
        if (!pending)
            throw new Error("unknown_tool_result");
        this.pending.delete(id);
        pending.resolve(result);
    }
    failAll(reason) {
        for (const pending of this.pending.values())
            pending.reject(new Error(reason));
        this.pending.clear();
    }
}
