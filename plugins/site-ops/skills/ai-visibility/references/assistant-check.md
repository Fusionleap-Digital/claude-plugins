# Asking the assistants

Goal: find out what ChatGPT, Claude, Perplexity, Gemini and Copilot say
about the company, and which wrong answers the site can fix.

## Set up

- Use a fresh chat in each assistant, signed out or in a private window
  where possible, with no memory or custom instructions about the company.
- Ask once with web search on (what a buyer sees today) and, where the
  assistant allows it, once with search off (what the model learned).
- Paste the answers back here, or save them to a file, with the assistant,
  the date and whether search was on.

## Questions

The site check's report lists these, filled in with the company name and
domain:

1. What is <name>?
2. What does <domain> do?
3. Who are the founders or leaders of <name>?
4. Where is <name> based?
5. What services does <name> offer, and for whom?
6. Is <name> the same company as <look-alike>? (only if the user knows of
   one; otherwise ask "Are there other companies called <name>?")

Add one or two questions a real buyer would ask, for example "Which firms
help mid-market companies put AI into production?", and note whether the
company appears.

## Compare

For each answer, mark each claim:

| Mark | Meaning | Fix on the site |
|---|---|---|
| Right | Matches the site | Nothing |
| Wrong company | Describes a look-alike (other domain, other country, other trade) | `disambiguatingDescription`, `sameAs`, address in the Organization schema; the same sentence in llms.txt and the About page |
| Out of date | Old services, old team, old location | Update the page it likely came from; check the old wording isn't still in llms.txt, the schema or profile pages |
| Made up | Not on the site or anywhere you can find | State the true fact plainly on the site (assistants fill gaps); nothing to remove |
| Missing | The assistant doesn't know the company | Check robots.txt allows the search agents, the site is indexed by Bing and Google (most assistants' search runs on them), and llms.txt exists |
| Cites another site | Answer comes from a directory, review site or the look-alike | Correct the directory listing; add it to `sameAs` if it's the company's own profile |

## Report

One table per assistant: question, short answer, mark, fix. Then a list
of site changes, each tied to the wrong answers it addresses. Assistants
with search pick up changes within days to weeks once the pages are
recrawled; answers from the model itself change only with a new model
version.
