// Test agent that refuses every task (tests/e2e_cloudflare.rs, F1): apply
// must never report it ready and must leave nothing on the host.
export default {
	async fetch(request, env) {
		if (request.headers.get("authorization") !== `Bearer ${env.BIMO_CONTROL_KEY}`) {
			return new Response("unauthorized\n", { status: 401 });
		}
		return Response.json({ error: "this agent refuses tasks" }, { status: 400 });
	},
};
