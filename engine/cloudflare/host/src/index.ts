// Bimo's Cloudflare host Worker: the substrate the engine's CloudflareDriver
// talks to (engine/src/cloudflare/mod.rs). It serves two things.
//
// 1. The control API under /v1/, for the operator's bimo only (bearer:
//    BIMO_OPERATOR_TOKEN). It stores agent generations and their routes,
//    rotates secret values and hands out audit lines. It never returns a
//    secret value.
// 2. Agent traffic under /a/<agent>/g<generation>/. Each generation runs as
//    a Dynamic Worker whose every outbound request goes through the
//    credential gateway (src/gateway.ts). The agent authenticates its own
//    callers with its control key, as on the other substrates.
//
// Plan and failure list: engine/docs/plans/2026-10-10-cloudflare-substrate.md.
import { AgentStore, type Generation } from "./agents";
import { sameSecret } from "./crypto";
import { Gateway } from "./gateway";
import { TenantVault, type RouteInput } from "./vault";

export { AgentStore, Gateway, TenantVault };

export interface Env {
	LOADER: WorkerLoader;
	AGENTS: DurableObjectNamespace<AgentStore>;
	VAULT: DurableObjectNamespace<TenantVault>;
	BIMO_OPERATOR_TOKEN?: string;
	BIMO_VAULT_KEK?: string;
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_MODULE_BYTES = 1024 * 1024;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code: string, message: string): Response {
	return json({ error: { code, message } }, status);
}

function routeId(agent: string, generation: number): string {
	return `${agent}-g${generation}`;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface PutGeneration {
	tenant: string;
	main: string;
	modules: Record<string, string>;
	env: Record<string, string>;
	compatibility_date: string;
	egress_allow: string[];
	secrets: { env: string; placeholder: string; hosts: string[]; value: string }[];
}

function validatePut(body: PutGeneration): string | null {
	if (typeof body !== "object" || body === null) return "body must be a JSON object";
	if (typeof body.tenant !== "string" || !NAME.test(body.tenant)) return "tenant must be a lowercase identifier";
	if (typeof body.main !== "string" || typeof body.modules !== "object" || !(body.main in body.modules))
		return "main must name one of modules";
	let size = 0;
	for (const [name, source] of Object.entries(body.modules)) {
		if (typeof source !== "string") return `module ${name} must be a string`;
		size += source.length;
	}
	if (size > MAX_MODULE_BYTES) return `modules total ${size} bytes; the limit is ${MAX_MODULE_BYTES}`;
	if (typeof body.env !== "object" || Object.values(body.env).some((v) => typeof v !== "string"))
		return "env must map names to strings";
	if (typeof body.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.compatibility_date))
		return "compatibility_date must be YYYY-MM-DD";
	if (!Array.isArray(body.egress_allow) || body.egress_allow.some((h) => typeof h !== "string"))
		return "egress_allow must be a list of hosts";
	if (!Array.isArray(body.secrets)) return "secrets must be a list";
	for (const secret of body.secrets) {
		if (typeof secret.env !== "string" || typeof secret.value !== "string") return "each secret needs env and value";
		if (typeof secret.placeholder !== "string" || secret.placeholder.length < 16)
			return `secret ${secret.env} needs a placeholder of at least 16 characters`;
		if (!Array.isArray(secret.hosts) || secret.hosts.some((h) => !body.egress_allow.includes(h)))
			return `every host of secret ${secret.env} must be in egress_allow`;
		if (Object.values(body.env).some((v) => v.includes(secret.value)))
			return `secret ${secret.env}'s value appears in env`;
	}
	return null;
}

async function control(request: Request, env: Env, url: URL, path: string[]): Promise<Response> {
	const auth = request.headers.get("authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	if (!env.BIMO_OPERATOR_TOKEN || !(await sameSecret(token, env.BIMO_OPERATOR_TOKEN))) {
		return problem(401, "unauthorized", "the control API needs the operator token");
	}

	// /v1/agents/<agent>/generations/<n>
	if (path[1] === "agents" && path[3] === "generations" && path.length === 5) {
		const agent = path[2];
		const generation = Number(path[4]);
		if (!NAME.test(agent) || !Number.isSafeInteger(generation) || generation < 1)
			return problem(400, "usage", "agent must be a lowercase identifier and generation a positive integer");
		const store = env.AGENTS.get(env.AGENTS.idFromName(agent));
		const route = routeId(agent, generation);

		if (request.method === "PUT") {
			const body = (await request.json().catch(() => null)) as PutGeneration;
			const invalid = validatePut(body);
			if (invalid) return problem(400, "usage", invalid);
			const codeHash = await sha256Hex(
				JSON.stringify([body.main, body.modules, body.env, body.compatibility_date, body.tenant]),
			);
			const record: Generation = {
				tenant: body.tenant,
				generation,
				route,
				main: body.main,
				modules: body.modules,
				env: body.env,
				compatibilityDate: body.compatibility_date,
				codeHash,
			};
			const owner = await store.owner();
			if (owner !== null && owner !== body.tenant)
				return problem(409, "tenant_conflict", `agent ${agent} belongs to another tenant`);
			// The route (the boundary) first: the agent must never be
			// reachable without it.
			const vault = env.VAULT.get(env.VAULT.idFromName(body.tenant));
			const input: RouteInput = { agent, allow: body.egress_allow, secrets: body.secrets };
			await vault.putRoute(body.tenant, route, input);
			if ((await store.put(record)) === "conflict") {
				await vault.deleteRoute(body.tenant, route);
				return problem(409, "tenant_conflict", `agent ${agent} belongs to another tenant`);
			}
			return json({ agent, generation, tenant: body.tenant, route, endpoint_path: `/a/${agent}/g${generation}` });
		}
		// GET and DELETE are scoped to ?tenant= (required for DELETE): a
		// generation another tenant owns does not exist for this caller.
		const tenant = url.searchParams.get("tenant");
		if (request.method === "GET") {
			const record = await store.get(generation);
			if (!record || (tenant !== null && record.tenant !== tenant))
				return problem(404, "agent_not_found", `${agent} generation ${generation} does not exist`);
			return json({ agent, generation, tenant: record.tenant, route: record.route, code_hash: record.codeHash });
		}
		if (request.method === "DELETE") {
			if (tenant === null || !NAME.test(tenant)) return problem(400, "usage", "DELETE needs ?tenant=<owner>");
			const record = await store.delete(generation, tenant);
			if (record) {
				await env.VAULT.get(env.VAULT.idFromName(record.tenant)).deleteRoute(record.tenant, record.route);
			}
			return json({ agent, generation, deleted: record !== null });
		}
		return problem(405, "usage", "use PUT, GET or DELETE");
	}

	// /v1/tenants/<tenant>/routes/<route>[/secrets|/audit]
	if (path[1] === "tenants" && path[3] === "routes" && (path.length === 5 || path.length === 6)) {
		const [tenant, route, action] = [path[2], path[4], path[5]];
		if (!NAME.test(tenant)) return problem(400, "usage", "tenant must be a lowercase identifier");
		const vault = env.VAULT.get(env.VAULT.idFromName(tenant));
		if (action === undefined && request.method === "GET") {
			const described = await vault.describe(tenant, route);
			return described ? json(described) : problem(404, "route_not_found", `route ${route} does not exist`);
		}
		// A route without its generation: what an interrupted apply leaves.
		// Its audit goes with it; bimo collects audit before it destroys.
		if (action === undefined && request.method === "DELETE") {
			const existed = (await vault.describe(tenant, route)) !== null;
			await vault.deleteRoute(tenant, route);
			return json({ tenant, route, deleted: existed });
		}
		if (action === "secrets" && request.method === "POST") {
			const body = (await request.json().catch(() => null)) as { secrets?: { env: string; value: string }[] } | null;
			if (!body || !Array.isArray(body.secrets)) return problem(400, "usage", "body must be {secrets: [{env, value}]}");
			const result = await vault.rotate(tenant, route, body.secrets);
			if (result === "missing") return problem(404, "route_not_found", `route ${route} does not exist`);
			if (result === "unknown") return problem(400, "usage", "a rotation may only replace secrets the route declares");
			return json({ rotated: body.secrets.map((s) => s.env) });
		}
		if (action === "audit" && request.method === "GET") {
			const text = await vault.readAudit(tenant, route);
			if (text === null) return problem(404, "route_not_found", `route ${route} does not exist`);
			return new Response(text, { headers: { "content-type": "application/x-ndjson" } });
		}
	}
	return problem(404, "usage", "unknown control path");
}

async function agentTraffic(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
	// /a/<agent>/g<n>/<rest>
	const match = /^\/a\/([a-z0-9-]+)\/g(\d+)(\/.*)?$/.exec(url.pathname);
	if (!match) return problem(404, "agent_not_found", "no such agent");
	const [agent, generation, rest] = [match[1], Number(match[2]), match[3] ?? "/"];
	const record = await env.AGENTS.get(env.AGENTS.idFromName(agent)).get(generation);
	if (!record) return problem(404, "agent_not_found", `${agent} generation ${generation} does not exist`);
	const worker = env.LOADER.get(`${agent}:g${generation}:${record.codeHash}`, async () => ({
		compatibilityDate: record.compatibilityDate,
		mainModule: record.main,
		modules: record.modules,
		env: record.env,
		globalOutbound: ctx.exports.Gateway({ props: { tenant: record.tenant, route: record.route } }),
	}));
	const inner = new URL(rest + url.search, url.origin);
	return worker.getEntrypoint().fetch(new Request(inner, request));
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.split("/").filter(Boolean);
		if (path[0] === "v1") return control(request, env, url, path);
		if (path[0] === "a") return agentTraffic(request, env, ctx, url);
		if (url.pathname === "/healthz") return json({ ok: true, service: "bimo-host" });
		return problem(404, "usage", "unknown path");
	},
} satisfies ExportedHandler<Env>;
