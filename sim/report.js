export function buildReport({ branches, metadata, tuningChanges }) {
  return {
    artifact: 'safety-school-phase-1-balance',
    schemaVersion: 1,
    metadata,
    tuningChanges,
    pass: branches.every((branch) => branch.evaluation.pass),
    branches,
  };
}

const percent = (value) => value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;

export function formatMarkdown(report) {
  const lines = [
    '# Safety School Phase 1 Balance Report',
    '',
    `**Overall:** ${report.pass ? 'PASS' : 'FAIL'}`,
    '',
    '## Evidence identity',
    '',
    `- Schedule: \`${report.metadata.scheduleIdentity}\``,
    `- Config: ${report.metadata.configVersion} (\`${report.metadata.configDigest}\`)`,
    `- Cards: ${report.metadata.cardsVersion} (\`${report.metadata.cardsDigest}\`)`,
    `- Agent policy: ${report.metadata.policyVersion} (\`${report.metadata.policyDigest}\`)`,
    `- Base seed: ${report.metadata.baseSeed}`,
    '',
    '## Branch results',
    '',
  ];

  for (const branch of report.branches) {
    const metrics = branch.metrics;
    lines.push(
      `### Programs ${branch.programsEnabled ? 'enabled' : 'disabled'} — ${branch.evaluation.pass ? 'PASS' : 'FAIL'}`,
      '',
      '| Metric | Value |',
      '|---|---:|',
      `| Games | ${metrics.gameCount} |`,
      `| Median ending round | ${metrics.medianEndRound} |`,
      `| Ended before configured early-round cutoff | ${percent(metrics.endingBeforeRoundShare)} |`,
      `| Reached Year 6 Health Score | ${percent(metrics.year6TiebreakShare)} |`,
      `| Austerity escape rate | ${percent(metrics.austerityEscapeRate)} |`,
      `| Replay identity | ${percent(metrics.replayRate)} |`,
      `| Maximum observed round | ${metrics.maxRound} |`,
      '',
      'Winner shares:',
      '',
      ...Object.entries(metrics.winnerShares).map(([type, value]) => `- ${type}: ${percent(value)}`),
      '',
    );
    if (branch.programsEnabled) {
      lines.push('Winning portfolio shares:', '', ...Object.entries(metrics.programWinnerShares)
        .map(([program, value]) => `- ${program}: ${percent(value)}`), '');
    }
    const failed = branch.evaluation.checks.filter((check) => !check.pass);
    lines.push('Acceptance checks:', '', ...(failed.length
      ? failed.map((check) => `- FAIL ${check.name}: ${check.value}`)
      : ['- All configured checks passed.']), '');
  }

  lines.push(
    '## Denominators',
    '',
    ...report.branches.flatMap((branch) => [
      `- Programs ${branch.programsEnabled ? 'enabled' : 'disabled'}: ${branch.metrics.gameCount} games; ${branch.metrics.denominators.austerityEntrants} austerity entrants; ${branch.metrics.denominators.replays} replays.`,
    ]),
    '',
    '## Config tuning',
    '',
    ...(report.tuningChanges.length ? report.tuningChanges.map((change) => `- ${change}`) : ['- No numeric tuning changes were required after the scored run.']),
    '',
    '## Human playtesting caveat',
    '',
    'Human playtesting is still required for fun, pacing, comprehension, and whether the satire lands. This report proves deterministic execution and configured statistical targets only.',
    '',
  );
  return lines.join('\n');
}
