export const VERSION = "agent-worker/v1" as const;

export type Direction = "worker_to_control" | "control_to_worker";

export type Frame = {
  protocol: typeof VERSION;
  direction: Direction;
  type: string;
  factory_gen: number;
  pod: string;
  session: string;
  seq: number;
  request_id?: string;
  tool_call_id?: string;
  payload: Record<string, unknown>;
};

const FRAME_KEYS: Record<string, true> = {
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

const CONTROL_TYPES: Record<string, true> = {
  hello_ack: true,
  work_request: true,
  tool_result: true,
  cancel: true,
  shutdown: true,
};

function assertRecord(value: unknown, error: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(error);
  }
}

function requiredString(frame: Record<string, unknown>, key: string): string {
  const value = frame[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid_frame_${key}`);
  }
  return value;
}

export function parseFrame(line: string, max = 65_536): Frame {
  if (Buffer.byteLength(line, "utf8") > max) {
    throw new Error("frame_too_large");
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
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
  if (!Number.isSafeInteger(value.factory_gen) || (value.factory_gen as number) < 1) {
    throw new Error("invalid_frame_generation");
  }
  requiredString(value, "pod");
  requiredString(value, "session");
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
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

  return value as Frame;
}

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}

type Pending = { resolve(value: unknown): void; reject(reason: Error): void };

export class HostToolBridge {
  private pending = new Map<string, Pending>();

  constructor(private readonly send: (name: string, args: unknown, id: string) => void) {}

  call(name: string, args: unknown, id: string): Promise<unknown> {
    if (!id || this.pending.has(id)) return Promise.reject(new Error("duplicate_tool_call_id"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(name, args, id);
    });
  }

  accept(id: string, result: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("unknown_tool_result");
    this.pending.delete(id);
    pending.resolve(result);
  }

  failAll(reason: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }
}
