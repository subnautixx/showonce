#!/usr/bin/env node
// `npx showonce`        the local server (only needed for the MCP assistant mode or a server-side API key)
// `npx showonce mcp`    the MCP connector an AI assistant launches
// `npx showonce demo`   the server with a canned example plan
import { readFileSync } from 'node:fs';

const [command = 'start'] = process.argv.slice(2);
const ENTRY = { start: './index.js', mcp: './mcp.js', demo: './demo.js' };

if (command === '--version' || command === '-v') {
  console.log(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version);
} else if (ENTRY[command]) {
  await import(ENTRY[command]);
} else {
  console.error('Usage: showonce [start|mcp|demo]');
  process.exit(command === '--help' || command === '-h' ? 0 : 1);
}
