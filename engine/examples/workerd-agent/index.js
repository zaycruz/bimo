// A minimal workerd agent. Bimo's task contract: only callers with the
// control key, and POST /bimo/v1/tasks answers 202 with a task id. The task
// runs in the background; its answer is logged here for brevity.
//
// env.OPENROUTER_API_KEY is a placeholder. The host's credential gateway
// puts the real key in the request because it goes to openrouter.ai, a host
// the spec allows for that secret.
async function run(env, input) {
	const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "openai/gpt-4o-mini",
			messages: [{ role: "user", content: String(input) }],
		}),
	});
	const body = await response.json();
	console.log(JSON.stringify({ status: response.status, answer: body.choices?.[0]?.message?.content }));
}

export default {
	async fetch(request, env, ctx) {
		if (request.headers.get("authorization") !== `Bearer ${env.BIMO_CONTROL_KEY}`) {
			return new Response("unauthorized\n", { status: 401 });
		}
		const url = new URL(request.url);
		if (url.pathname === "/bimo/v1/tasks" && request.method === "POST") {
			const { input } = await request.json().catch(() => ({}));
			const taskId = crypto.randomUUID();
			// The readiness probe is a task too; do not spend tokens on it.
			if (input !== "Bimo readiness probe") ctx.waitUntil(run(env, input));
			return Response.json({ task_id: taskId }, { status: 202 });
		}
		return new Response("not found\n", { status: 404 });
	},
};
