# Vendor terms to confirm

Code can show that data goes to a vendor. It can't show what the vendor
keeps, for how long, or whether it trains on it. Those answers come from the
contract and the account settings, so every row here goes in the packet as
**[Ask team]** until someone confirms it against the current terms.

Vendor terms change. Don't state a vendor's retention or training policy as
fact in the packet; write the question, and note where to check.

## Questions for every vendor that receives data

- [ ] Which agreement covers our use (self-serve terms, enterprise agreement, cloud marketplace)?
- [ ] How long are API inputs and outputs kept, and why (abuse monitoring, debugging, features like stored responses)?
- [ ] Are inputs or outputs used to train or improve models under our agreement?
- [ ] Is zero data retention (or a shorter retention) available, and do we have it?
- [ ] Where is data processed and stored? Can we pin a region?
- [ ] Is there a signed DPA? Is the vendor on our sub-processor list?
- [ ] If PHI is in scope: is there a signed BAA, and is this specific service covered by it?
- [ ] If financial customer data is in scope (GLBA): does the contract require the vendor to safeguard it?
- [ ] Who on our side can see the vendor console, logs and usage? Is SSO on?
- [ ] How does the vendor notify us of a breach, and how fast?
- [ ] Which certifications can they share (SOC 2 Type II report, ISO 27001, ISO 42001)?

## Where to look, by vendor

| Vendor | Settings and features that change the answer | Where to check |
|---|---|---|
| Anthropic API | Commercial vs consumer terms; zero data retention addendum; workspace data settings | Anthropic Trust Center (trust.anthropic.com) and the commercial terms |
| OpenAI API | `store` parameter on the Responses / Chat Completions API (stored responses); zero data retention eligibility; data controls in the org settings | OpenAI Trust Portal (trust.openai.com) and the enterprise privacy page |
| Azure OpenAI | Abuse monitoring and whether a modified-abuse-monitoring exemption is approved; deployment region and data zone | Microsoft Learn "Data, privacy and security for Azure OpenAI" |
| AWS Bedrock | Model invocation logging (off unless configured, and then written to your own S3/CloudWatch); cross-region inference profiles (`us.`, `eu.`, `global.` model IDs route across regions) | AWS Bedrock security and data protection docs; AWS BAA eligible services list |
| Google Vertex AI | Data caching and how to turn it off; region; abuse monitoring logging | Google Cloud "Vertex AI generative AI data governance" |
| Google Gemini API (AI Studio) | Free tier vs paid tier terms differ on use for product improvement | Gemini API additional terms |
| Mistral, Cohere, Groq, Together, Fireworks, others | Retention and training terms for the API tier you use | Each vendor's privacy policy, DPA and trust page |
| Vector databases (Pinecone, Weaviate Cloud, Qdrant Cloud, Zilliz, turbopuffer, Upstash) | Region; encryption; backups; whether the vendor's staff can read your data | The vendor's security page and DPA |
| LLM tracing (Langfuse Cloud, LangSmith, Helicone, Braintrust, Arize) | These usually receive full prompts and outputs. Retention period, region, masking options, self-hosting | Vendor docs on data retention and masking |
| Error and analytics tools (Sentry, Datadog, PostHog, session replay) | Whether request bodies, prompts or screen contents are captured | Their data scrubbing settings |
| Search, scraping, parsing (Tavily, SerpAPI, Exa, Firecrawl, Unstructured, LlamaParse, Textract) | They receive queries or whole documents | Vendor privacy terms |

## Bedrock and cross-region model IDs

A Bedrock model ID that starts with `us.`, `eu.`, `apac.` or `global.` is an
inference profile: requests can be served from another region in that
geography (or anywhere, for `global.`). If data residency matters, note the
prefix in section 3 and ask whether it's acceptable.
