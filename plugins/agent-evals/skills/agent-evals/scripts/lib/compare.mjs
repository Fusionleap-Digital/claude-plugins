// Pass-rate changes between two saved runs.

export function compareRuns(base, head, threshold) {
  const key = (c) => `${c.suite}/${c.id}`;
  const b = new Map(base.cases.map((c) => [key(c), c]));
  const h = new Map(head.cases.map((c) => [key(c), c]));
  const cases = [];
  for (const k of new Set([...b.keys(), ...h.keys()])) {
    const x = b.get(k);
    const y = h.get(k);
    const [suite, ...rest] = k.split('/');
    const row = { suite, id: rest.join('/'), base: x ? x.pass_rate : null, head: y ? y.pass_rate : null, base_status: x?.status, head_status: y?.status };
    if (!x) row.change = 'new';
    else if (!y) row.change = 'removed';
    else {
      row.delta = y.pass_rate - x.pass_rate;
      row.edited = x.hash !== y.hash;
      row.change = row.delta < -threshold ? 'regressed' : row.delta < 0 ? 'worse' : row.delta > threshold ? 'improved' : row.delta > 0 ? 'better' : 'same';
    }
    cases.push(row);
  }

  const bs = new Map(base.suites.map((s) => [s.name, s]));
  const hs = new Map(head.suites.map((s) => [s.name, s]));
  const suites = [...new Set([...bs.keys(), ...hs.keys()])].map((name) => {
    const x = bs.get(name);
    const y = hs.get(name);
    const delta = x && y ? y.pass_rate - x.pass_rate : null;
    return { name, base: x ? x.pass_rate : null, head: y ? y.pass_rate : null, delta, regressed: delta !== null && delta < -threshold };
  });

  const notes = [];
  const minRepeats = Math.min(...base.cases.concat(head.cases).map((c) => c.repeats));
  if (minRepeats < 3) notes.push(`Some cases ran fewer than 3 times. With few repeats, one flaky run moves the pass rate a lot; use --repeats 5 or more before trusting small changes.`);
  if (base.meta.target !== head.meta.target) notes.push(`The runs used different targets: ${base.meta.target} vs ${head.meta.target}.`);
  if (base.meta.graded.enabled !== head.meta.graded.enabled) notes.push(`Graded checks ran in only one of the runs (${base.meta.graded.enabled ? 'base' : 'head'}), so cases with rubric checks are not comparable.`);
  const removed = cases.filter((c) => c.change === 'removed').length;
  if (removed) notes.push(`${removed} case${removed > 1 ? 's' : ''} from the base run ${removed > 1 ? 'are' : 'is'} missing from the head run.`);

  const regressions = [
    ...cases.filter((c) => c.change === 'regressed').map((c) => ({ kind: 'case', name: `${c.suite}/${c.id}`, base: c.base, head: c.head })),
    ...suites.filter((s) => s.regressed).map((s) => ({ kind: 'suite', name: s.name, base: s.base, head: s.head })),
  ];
  const improvements = cases.filter((c) => c.change === 'improved').map((c) => ({ name: `${c.suite}/${c.id}`, base: c.base, head: c.head }));

  return {
    meta: {
      threshold,
      base: { run_id: base.meta.run_id, label: base.meta.label, target: base.meta.target, started_at: base.meta.started_at },
      head: { run_id: head.meta.run_id, label: head.meta.label, target: head.meta.target, started_at: head.meta.started_at },
    },
    suites,
    cases,
    regressions,
    improvements,
    notes,
  };
}
