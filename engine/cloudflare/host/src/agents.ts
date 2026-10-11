// One AgentStore Durable Object per agent name. It records which tenant
// owns the name and the code and environment of each live generation. The
// environment holds the control key and placeholders, never a secret value.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

export interface Generation {
	tenant: string;
	generation: number;
	route: string;
	main: string;
	modules: Record<string, string>;
	env: Record<string, string>;
	compatibilityDate: string;
	codeHash: string;
}

export class AgentStore extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS generations (
			generation INTEGER PRIMARY KEY, tenant TEXT NOT NULL, record TEXT NOT NULL)`);
	}

	// The tenant that owns this agent name, if any generation exists.
	owner(): string | null {
		const row = this.sql.exec("SELECT tenant FROM generations LIMIT 1").toArray()[0];
		return row ? (row.tenant as string) : null;
	}

	put(record: Generation): "ok" | "conflict" {
		const owner = this.owner();
		if (owner !== null && owner !== record.tenant) return "conflict";
		this.sql.exec(
			"INSERT OR REPLACE INTO generations (generation, tenant, record) VALUES (?, ?, ?)",
			record.generation,
			record.tenant,
			JSON.stringify(record),
		);
		return "ok";
	}

	get(generation: number): Generation | null {
		const row = this.sql.exec("SELECT record FROM generations WHERE generation = ?", generation).toArray()[0];
		return row ? (JSON.parse(row.record as string) as Generation) : null;
	}

	// Delete a generation only for the tenant that owns it. Another
	// tenant's delete finds nothing: a rolled-back takeover attempt must
	// not remove the owner's agent.
	delete(generation: number, tenant: string): Generation | null {
		const existing = this.get(generation);
		if (!existing || existing.tenant !== tenant) return null;
		this.sql.exec("DELETE FROM generations WHERE generation = ?", generation);
		return existing;
	}
}
