const [command = 'unknown', phase = 'a later milestone'] = process.argv.slice(2);
console.error(`${command} is not implemented yet (planned for Phase ${phase}). See docs/BUILD_STATUS.md.`);
process.exitCode = 1;
