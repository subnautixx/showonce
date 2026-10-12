// `npm run demo`: mock provider, no API key. Set here instead of in the npm script
// because `VAR=value command` does not work in the Windows shell.
process.env.SHOWONCE_PROVIDER = 'mock';
await import('./index.js');
