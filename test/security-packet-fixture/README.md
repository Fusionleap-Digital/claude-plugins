# claims-copilot (test fixture)

Not a real app. A small Next.js + Python RAG service used to test the
`security-review-packet` plugin. It has deliberate gaps (an ingest route
with no auth check, an agent tool that runs model-written SQL, prompts in
logs, an unpinned MCP server) next to real controls (NextAuth, rate
limiting, tenant filters, an approval step), so the packet has both to
report.

Nothing here runs or deploys. Secret-looking values are fake.
