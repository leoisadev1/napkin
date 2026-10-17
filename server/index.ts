// Placeholder. The backend worker replaces this with the real Bun API server.
Bun.serve({ port: Number(process.env.API_PORT ?? 8787), fetch: () => new Response("not implemented", { status: 501 }) });
