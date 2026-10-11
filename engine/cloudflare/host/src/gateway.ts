// The credential gateway: every fetch() a Dynamic Worker agent makes arrives
// here (its globalOutbound). It applies the same rules as the iron-proxy
// configuration the engine renders for the other substrates
// (engine/src/proxy/config.rs, docs/credential-boundary.md):
//
// - a request to a host outside the route's allowlist is refused with 403,
//   audited with rejected_by "allowlist", and never leaves;
// - a placeholder is swapped for its real value in any request header, only
//   when the request goes to one of that secret's hosts; a placeholder sent
//   anywhere else is forwarded unchanged;
// - redirects are returned to the agent, never followed here, so a swapped
//   value cannot follow a redirect to another host;
// - raw TCP (connect()) is refused;
// - every request gets one audit line; values are never logged.
//
// The route comes from props the host Worker set when it loaded the agent,
// so an agent cannot pick another route or tenant.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index";

export interface GatewayProps {
	tenant: string;
	route: string;
}

// Mirrors spec::host_allowed: `*.example.com` matches subdomains of
// example.com but not example.com itself; anything else matches exactly.
export function hostAllowed(host: string, allow: string[]): boolean {
	const lower = host.toLowerCase();
	return allow.some((entry) => {
		if (entry.startsWith("*.")) return lower.endsWith(`.${entry.slice(2)}`);
		return entry === lower;
	});
}

export class Gateway extends WorkerEntrypoint<Env, GatewayProps> {
	async fetch(request: Request): Promise<Response> {
		const { tenant, route } = this.ctx.props;
		const vault = this.env.VAULT.get(this.env.VAULT.idFromName(tenant));
		const url = new URL(request.url);
		const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		const audit = (fields: Record<string, unknown>) =>
			vault.appendAudit(
				route,
				JSON.stringify({
					time: new Date().toISOString(),
					msg: "request",
					route,
					...fields,
				}),
			);
		const entry = (action: string, status: number) => ({
			host,
			method: request.method,
			path: url.pathname,
			action,
			status_code: status,
		});

		const opened = await vault.openRoute(tenant, route);
		if (!opened) {
			// The route was destroyed; nothing of this generation may go out.
			return new Response("bimo gateway: route not found\n", { status: 403 });
		}
		if ((url.protocol !== "https:" && url.protocol !== "http:") || !hostAllowed(host, opened.allow)) {
			await audit({ audit: entry("reject", 403), rejected_by: "allowlist" });
			return new Response(`bimo gateway: ${host} is not in this agent's egress allowlist\n`, { status: 403 });
		}

		const headers = new Headers(request.headers);
		const swapped = new Set<string>();
		for (const secret of opened.secrets) {
			if (!secret.placeholder || !hostAllowed(host, secret.hosts)) continue;
			for (const [name, value] of headers) {
				if (value.includes(secret.placeholder)) {
					headers.set(name, value.split(secret.placeholder).join(secret.value));
					swapped.add(name);
				}
			}
		}

		let response: Response;
		try {
			response = await fetch(url.toString(), {
				method: request.method,
				headers,
				body: request.body,
				redirect: "manual",
			});
		} catch (error) {
			await audit({ audit: entry("error", 502), error: String(error) });
			return new Response("bimo gateway: upstream request failed\n", { status: 502 });
		}
		await audit({
			audit: entry("allow", response.status),
			...(swapped.size > 0 ? { annotations: { swapped: [...swapped].sort() } } : {}),
		});
		return response;
	}

	// Raw TCP from an agent is refused; the boundary covers HTTP only. The
	// agent's socket may report opened, but it carries nothing and fails.
	connect(): never {
		throw new Error("bimo gateway: raw TCP connections are not allowed");
	}
}
