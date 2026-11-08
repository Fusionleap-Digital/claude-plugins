---
name: ai-visibility
description: Check whether AI assistants (ChatGPT, Claude, Perplexity, Gemini, Copilot) can read a company's website and describe the company correctly. Checks robots.txt rules for each AI crawler, llms.txt, Organization and WebSite structured data, disambiguatingDescription and basic meta tags, then guides asking the assistants about the company and comparing their answers with the site. Use when the user asks how their company shows up in AI answers, whether AI crawlers are blocked, about llms.txt or schema.org Organization markup, or when assistants confuse the company with a look-alike company on another domain.
---

# AI visibility

Two parts:

1. **Site check** (`scripts/ai-visibility.mjs`): what the site tells AI
   crawlers.
2. **Assistant check** (`references/assistant-check.md`): what the
   assistants actually say, compared with the site.

Background: assistants mixed up FusionLeap Digital (fusionleap.io) with a
digital agency of almost the same name on fusionleap.net. A
`disambiguatingDescription` in the Organization schema, a clear llms.txt
and consistent profile links (`sameAs`) are the levers a site has.

## Rules

- **The user's own site only.**
- **Read-only.** GET requests, 2 per second by default (5 max).
- **Don't invent facts for the schema or llms.txt.** Every claim you draft
  (location, founding year, services, people) must come from the site, the
  repo or the user. Ask when unsure.
- **Robots rules for AI crawlers are the user's policy.** Report what's
  allowed and what that means; change it only when they decide.

## 1. Site check

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/ai-visibility/scripts/ai-visibility.mjs" https://example.com --name "Example Co" --path /about
```

- `--name` is the company name as it should appear; flags a mismatch with
  the schema.
- `--path` adds pages to check for meta tags and structured data (the
  Organization checks run on the home page).
- Writes `report.md` and `report.json`. Exit code 1 means a critical or high
  finding.

| Check | Fails when |
|---|---|
| robots-blocks-ai-search (high) | robots.txt blocks a search or user-fetch agent (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Amazonbot): the site can't be cited in those answers |
| robots-blocks-training (info) | robots.txt blocks a training crawler (GPTBot, ClaudeBot, Google-Extended, CCBot, …): a policy choice, not a fault |
| noindex (critical) | The home page or a checked page says noindex |
| schema-organization, org-* | No Organization JSON-LD, or it lacks name, url (on this host), description, logo, sameAs, contact or location |
| org-disambiguating | No `disambiguatingDescription`; or it doesn't name the domain |
| schema-website | No WebSite JSON-LD, or no publisher link to the Organization |
| schema-invalid-json | A JSON-LD block doesn't parse, so it's ignored |
| llms-txt, llms-* | No `/llms.txt` (low: optional), no title or summary line, wrong content type, broken links |
| canonical-host | The canonical link points at another host |

Robots verdicts use the same matching rules crawlers use (most specific
user-agent group, longest path match, Allow wins a tie). Whether an edge
firewall (Cloudflare "Block AI bots", AWS WAF bot control) lets the crawlers
through is not visible from outside; check the host's settings.

## 2. Fix what the site says

Draft fixes from facts on the site and in the repo:

- **Organization JSON-LD** in the root layout, one per site:
  `name`, `legalName`, `url`, `logo`, `description` (one plain sentence),
  `disambiguatingDescription`, `sameAs` (LinkedIn, GitHub, Crunchbase,
  …), `address` or `areaServed`, `contactPoint`. Give it an `@id`
  (`https://example.com/#organization`) and point WebSite's `publisher` at
  it.
- **disambiguatingDescription**: who you are, where, your domain, and who
  you are not. Example: "An AI engineering firm in Sacramento, California
  (fusionleap.io). Not affiliated with Fusion Leap (fusionleap.net), a
  digital agency in Marrakech, Morocco." Name the look-alike only if the
  user agrees.
- **llms.txt**: `# Name`, a `> ` one-paragraph summary, then sections of
  links to the pages that matter, each with a short description. Plain
  facts, same wording as the site.
- Keep the name, description and location the same across the site,
  schema, llms.txt and the `sameAs` profiles. Mismatches are what
  assistants trip on.

## 3. Assistant check

Work through `references/assistant-check.md` with the questions the
report lists. This part is manual: the user (or you, if you have the
assistants available as tools) asks each assistant, then you compare the
answers with the site and the schema.

## Report

Lead with anything that keeps the site out of AI answers (noindex,
blocked search agents, broken schema), then identity gaps (no
disambiguatingDescription, no sameAs, mismatched names), then llms.txt.
Then the assistant check: per assistant, what it got right, what it got
wrong, and which site change addresses each error. Note that assistants
update on their own schedule; re-check in a few weeks.
