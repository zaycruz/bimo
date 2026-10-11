// Test agent for the Cloudflare substrate E2E (tests/e2e_cloudflare.rs).
// Serves the workerd runtime's task contract and, behind the control key,
// probes the credential boundary from inside the agent.
function authorized(request, env) {
	return request.headers.get("authorization") === `Bearer ${env.BIMO_CONTROL_KEY}`;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (!authorized(request, env)) {
			return new Response("unauthorized\n", { status: 401 });
		}
		if (url.pathname === "/bimo/v1/tasks" && request.method === "POST") {
			return Response.json({ task_id: crypto.randomUUID() }, { status: 202 });
		}
		if (url.pathname === "/bimo/v1/info") {
			return Response.json({ runtime: "workerd", agent: "cf-test-agent" });
		}
		// Everything the agent can see in its environment.
		if (url.pathname === "/test/env") {
			return Response.json(env);
		}
		// Make one outbound request: ?url=...&header=Name:EnvVar (repeatable)
		// sends the env var's value (a placeholder) in that header.
		if (url.pathname === "/test/call") {
			const headers = new Headers();
			for (const spec of url.searchParams.getAll("header")) {
				const at = spec.indexOf(":");
				const name = spec.slice(0, at);
				const variable = spec.slice(at + 1);
				headers.set(name, env[variable] ?? variable);
			}
			try {
				const response = await fetch(url.searchParams.get("url"), { headers, redirect: "manual" });
				return Response.json({ status: response.status, location: response.headers.get("location"), body: await response.text() });
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 599 });
			}
		}
		// Try a raw TCP connection: ?host=...&port=... Sends an HTTP request
		// over the socket and reports what came back, so an opened socket
		// that carries nothing does not count as reaching the network.
		if (url.pathname === "/test/connect") {
			try {
				const { connect } = await import("cloudflare:sockets");
				const socket = connect({ hostname: url.searchParams.get("host"), port: Number(url.searchParams.get("port")) });
				const writer = socket.writable.getWriter();
				await writer.write(new TextEncoder().encode("GET /tcp HTTP/1.0\r\nHost: tcp\r\n\r\n"));
				const reader = socket.readable.getReader();
				const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000));
				const read = await Promise.race([reader.read(), timeout]);
				const text = read.value ? new TextDecoder().decode(read.value) : "";
				return Response.json({ reached: text.startsWith("HTTP/"), received: text.slice(0, 40), timeout: !!read.timeout });
			} catch (error) {
				return Response.json({ reached: false, error: String(error) });
			}
		}
		return new Response("not found\n", { status: 404 });
	},
};
