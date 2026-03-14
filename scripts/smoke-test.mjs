import { spawn } from 'node:child_process';
import process from 'node:process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const steps = [
  { name: 'Typecheck', args: ['run', 'typecheck'] },
  { name: 'Build', args: ['run', 'build'] },
  { name: 'Navigation regression', args: ['run', 'test:navigation-regression'] },
];

function runStep(step) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n[smoke] ${step.name}: npm ${step.args.join(' ')}\n`);

    const child = spawn(npmCommand, step.args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', (error) => {
      reject(new Error(`[smoke] Failed to start ${step.name}: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`[smoke] ${step.name} terminated by signal ${signal}`));
        return;
      }

      reject(new Error(`[smoke] ${step.name} failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

async function main() {
  for (const step of steps) {
    await runStep(step);
  }

  process.stdout.write('\n[smoke] All smoke-test steps passed.\n');
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
});
