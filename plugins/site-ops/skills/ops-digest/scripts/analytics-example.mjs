// Analytics extension point for the ops digest. Copy this file, fill in
// the fetch, and pass it with --analytics ./my-analytics.mjs.
//
// The digest calls the default export once per run with the site origin and
// the last 7 days as ISO strings, and shows what it returns. Keep API keys
// in env vars (never in this file) and never put them in the result.
//
// A WysLeap module will plug in here once WysLeap API access is available.

export default async function analytics({ site, since, until }) {
  // const res = await fetch(`https://analytics.example/api/summary?site=${encodeURIComponent(site)}&from=${since}&to=${until}`, {
  //   headers: { authorization: `Bearer ${process.env.ANALYTICS_API_KEY}` },
  // });
  // const data = await res.json();
  void site; void since; void until;
  return {
    title: 'Analytics (example module)',
    summary: ['No analytics source connected. This is the example module; copy it and fill in the fetch.'],
    metrics: {
      // 'Visitors (7 days)': data.visitors,
      // 'Contact form submissions': data.leads,
    },
    findings: [
      // { severity: 'medium', check: 'traffic-drop', detail: 'Visitors down 40% week over week.' },
    ],
  };
}
