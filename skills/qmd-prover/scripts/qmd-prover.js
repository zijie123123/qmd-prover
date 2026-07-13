#!/usr/bin/env node
import { main } from './lib/cli.js';
import { asErrorLike } from './lib/errors.js';
main(process.argv.slice(2)).catch((error) => {
    const failure = asErrorLike(error);
    process.stderr.write(`${failure.stack ?? failure.message}\n`);
    process.exitCode = failure.exitCode ?? 1;
});
