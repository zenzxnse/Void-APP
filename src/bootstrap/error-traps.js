process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', promise, '\n', reason);
});

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  process.exit(1);
});