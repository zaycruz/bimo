// One TenantVault Durable Object per tenant (named by tenant id). It holds
// the tenant's routes: one per agent generation, with that generation's
// egress allowlist, its placeholders and their hosts, and the secret values
// sealed under the vault key. It also keeps the routes' audit lines.
//
// Only the gateway reads a value back, and only to swap it into a request
// to that secret's host. No method returns a value to a caller outside this
// Worker.
import { DurableObject } from "cloudflare:workers";
import { open, seal, type Sealed } from "./crypto";
import type { Env } from "./index";

export interface RouteSecret {
	env: string;
	placeholder: string;
	hosts: string[];
}

export interface RouteInput {
	agent: string;
	allow: string[];
	secrets: (RouteSecret & { value: string })[];
}

export interface OpenRoute {
	allow: string[];
	secrets: (RouteSecret & { value: string })[];
}

interface StoredSecret extends RouteSecret {
	sealed: Sealed;
}

export class TenantVault extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS routes (
			route TEXT PRIMARY KEY, tenant TEXT NOT NULL, agent TEXT NOT NULL,
			allow TEXT NOT NULL, secrets TEXT NOT NULL)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS audit (
			seq INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT NOT NULL, line TEXT NOT NULL)`);
	}

	private aad(tenant: string, route: string, env: string): string {
		return `bimo-vault/v1\0${tenant}\0${route}\0${env}`;
	}

	async putRoute(tenant: string, route: string, input: RouteInput): Promise<void> {
		const secrets: StoredSecret[] = [];
		for (const secret of input.secrets) {
			secrets.push({
				env: secret.env,
				placeholder: secret.placeholder,
				hosts: secret.hosts,
				sealed: await seal(this.env.BIMO_VAULT_KEK, this.aad(tenant, route, secret.env), secret.value),
			});
		}
		this.sql.exec(
			"INSERT OR REPLACE INTO routes (route, tenant, agent, allow, secrets) VALUES (?, ?, ?, ?, ?)",
			route,
			tenant,
			input.agent,
			JSON.stringify(input.allow),
			JSON.stringify(secrets),
		);
	}

	// Replace the values of existing secrets in place. Unknown names are
	// refused so a rotation cannot add a secret the spec never declared.
	async rotate(tenant: string, route: string, values: { env: string; value: string }[]): Promise<"ok" | "missing" | "unknown"> {
		const row = this.sql.exec("SELECT secrets FROM routes WHERE route = ? AND tenant = ?", route, tenant).toArray()[0];
		if (!row) return "missing";
		const secrets = JSON.parse(row.secrets as string) as StoredSecret[];
		for (const { env, value } of values) {
			const secret = secrets.find((s) => s.env === env);
			if (!secret) return "unknown";
			secret.sealed = await seal(this.env.BIMO_VAULT_KEK, this.aad(tenant, route, env), value);
		}
		this.sql.exec("UPDATE routes SET secrets = ? WHERE route = ?", JSON.stringify(secrets), route);
		return "ok";
	}

	// The route without values: what an operator may see.
	describe(tenant: string, route: string): { agent: string; allow: string[]; secrets: RouteSecret[] } | null {
		const row = this.sql.exec("SELECT agent, allow, secrets FROM routes WHERE route = ? AND tenant = ?", route, tenant).toArray()[0];
		if (!row) return null;
		const secrets = (JSON.parse(row.secrets as string) as StoredSecret[]).map(({ env, placeholder, hosts }) => ({
			env,
			placeholder,
			hosts,
		}));
		return { agent: row.agent as string, allow: JSON.parse(row.allow as string), secrets };
	}

	// For the gateway only (called from inside this Worker).
	async openRoute(tenant: string, route: string): Promise<OpenRoute | null> {
		const row = this.sql.exec("SELECT allow, secrets FROM routes WHERE route = ? AND tenant = ?", route, tenant).toArray()[0];
		if (!row) return null;
		const stored = JSON.parse(row.secrets as string) as StoredSecret[];
		const secrets = [];
		for (const secret of stored) {
			secrets.push({
				env: secret.env,
				placeholder: secret.placeholder,
				hosts: secret.hosts,
				value: await open(this.env.BIMO_VAULT_KEK, this.aad(tenant, route, secret.env), secret.sealed),
			});
		}
		return { allow: JSON.parse(row.allow as string), secrets };
	}

	deleteRoute(tenant: string, route: string): void {
		this.sql.exec("DELETE FROM routes WHERE route = ? AND tenant = ?", route, tenant);
		this.sql.exec("DELETE FROM audit WHERE route = ?", route);
	}

	appendAudit(route: string, line: string): void {
		this.sql.exec("INSERT INTO audit (route, line) VALUES (?, ?)", route, line);
	}

	readAudit(tenant: string, route: string): string | null {
		const known = this.sql.exec("SELECT 1 FROM routes WHERE route = ? AND tenant = ?", route, tenant).toArray().length > 0;
		const lines = this.sql.exec("SELECT line FROM audit WHERE route = ? ORDER BY seq", route).toArray();
		if (!known && lines.length === 0) return null;
		return lines.map((r) => `${r.line as string}\n`).join("");
	}
}
