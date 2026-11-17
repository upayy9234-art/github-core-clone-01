// Local-only bench runner: runs the SEALED kit benchmark (sdk/conformance
// copies of program/env/src/bench.ts) against a server that is already
// running, and prints the resulting PerfFile as one JSON object on stdout.
//
//   node --experimental-strip-types tools/run-bench.ts --url http://127.0.0.1:PORT --token TOK [--rounds N] [--workloads push,clone]
//
// The kit path below is absolute on purpose: the kit is sealed and must not
// be copied into the entry. Nothing here is graded; the numbers are the
// official workload definitions (3 rounds x ops, same setup, same T_ref).

import { runBenchmark } from '/home/hatch/workspace/makefun/github-core-clone-01-kit/program/env/src/bench.ts';

const args = process.argv.slice(2);
let url = '';
let token = '';
let rounds = 3;
let workloads: string[] | undefined;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url') url = args[++i] ?? '';
  else if (args[i] === '--token') token = args[++i] ?? '';
  else if (args[i] === '--rounds') rounds = Number(args[++i] ?? 3);
  else if (args[i] === '--workloads') workloads = (args[++i] ?? '').split(',').filter(Boolean) as never;
}
if (url === '' || token === '') {
  process.stderr.write('usage: run-bench.ts --url URL --token TOK [--rounds N] [--workloads a,b]\n');
  process.exit(2);
}
const perf = await runBenchmark({
  baseUrl: url,
  token,
  rounds,
  workloads: workloads as never,
  log: (line: string) => process.stderr.write(`${line}\n`),
});
process.stdout.write(`${JSON.stringify(perf)}\n`);
