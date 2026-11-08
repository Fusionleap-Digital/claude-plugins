# How each crawler can be verified

What `bot-verify.mjs` uses. Owners change these, so if a list stops
loading, check the owner's crawler page and update `CRAWLERS` in the
script.

| Crawler (user agent) | Owner | Published IP list | Reverse DNS ends in |
|---|---|---|---|
| Googlebot | Google | `developers.google.com/static/search/apis/ipranges/googlebot.json` | `googlebot.com`, `google.com` |
| Google-Extended, GoogleOther, AdsBot, Storebot, Google-InspectionTool | Google | `…/special-crawlers.json` (+ googlebot.json) | `googlebot.com`, `google.com`, `googleusercontent.com` |
| bingbot, BingPreview, msnbot | Microsoft | `www.bing.com/toolbox/bingbot.json` | `search.msn.com` |
| GPTBot | OpenAI | `openai.com/gptbot.json` | none |
| OAI-SearchBot | OpenAI | `openai.com/searchbot.json` | none |
| ChatGPT-User | OpenAI | `openai.com/chatgpt-user.json` | none |
| ClaudeBot, Claude-SearchBot, Claude-User | Anthropic | `claude.com/crawling/bots.json` | none |
| PerplexityBot | Perplexity | `www.perplexity.com/perplexitybot.json` | none |
| Perplexity-User | Perplexity | `www.perplexity.com/perplexity-user.json` | none |
| CCBot | Common Crawl | `index.commoncrawl.org/ccbot.json` | none used |
| Applebot | Apple | `search.developer.apple.com/applebot.json` | `applebot.apple.com` |
| Amazonbot | Amazon | none in JSON | `crawl.amazonbot.amazon` |
| DuckDuckBot, DuckAssistBot | DuckDuckGo | `duckduckgo.com/duckduckbot.json` | none |
| Bytespider | ByteDance | none | none: can't be verified |
| meta-externalagent | Meta | none | none: can't be verified |
| cohere-ai | Cohere | none | none: can't be verified |

Notes:

- "User fetch" agents (ChatGPT-User, Claude-User, Perplexity-User) fetch a
  page because a person asked an assistant about it. They are genuine
  traffic from real people's questions, and some owners say they may not
  follow robots.txt.
- Reverse DNS alone proves nothing: anyone can set a PTR record on their
  own IP to `crawl-1.googlebot.com`. The forward lookup back to the same
  IP is what makes it proof.
- The published lists are cached for 24 hours in the system temp folder
  (`site-ops-crawler-ranges/`). Delete that folder to force a fresh
  download.
- To add a crawler, add a row to `CRAWLERS` in `scripts/bot-verify.mjs`
  with its user-agent pattern and either `ranges` (JSON with
  `prefixes[].ipv4Prefix|ipv6Prefix`) or `rdns` suffixes.
