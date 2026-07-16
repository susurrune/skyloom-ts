import { runBaselineEvals } from './baseline';

const report = runBaselineEvals();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.aggregate.passed !== report.aggregate.total) process.exitCode = 1;
