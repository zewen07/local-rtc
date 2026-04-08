#!/usr/bin/env node

const pkg = require("./package.json");
const { getLanAddresses, startServer } = require("./server");

function printHelp() {
  console.log(`
Local RTC CLI

Usage:
  local-rtc [options]

Options:
  --port <number>   Set the HTTP port. Default: 3000
  --host <address>  Set the listen host. Default: 0.0.0.0
  --no-open         Reserved for future browser auto-open support
  --help            Show this help message
  --version         Show the current version

Examples:
  local-rtc
  local-rtc --port 3100
  local-rtc --host 127.0.0.1 --port 3100
`);
}

function parseArgs(argv) {
  const options = {
    host: "0.0.0.0",
    port: 3000,
    open: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      options.version = true;
      continue;
    }

    if (arg === "--no-open") {
      options.open = false;
      continue;
    }

    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing value for --port");
      }
      options.port = Number(value);
      index += 1;
      continue;
    }

    if (arg === "--host") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing value for --host");
      }
      options.host = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }

  return options;
}

function printAddresses(host, port) {
  console.log("Local RTC server is ready.");

  if (host === "0.0.0.0") {
    console.log(`Local:       http://localhost:${port}`);
    const lanAddresses = getLanAddresses();

    if (lanAddresses.length) {
      console.log(`Recommended: http://${lanAddresses[0].address}:${port}`);
      for (const item of lanAddresses.slice(1)) {
        console.log(`Other LAN:   http://${item.address}:${port}`);
      }
    } else {
      console.log("Recommended: No active private IPv4 LAN address detected.");
    }
    return;
  }

  console.log(`Local:       http://${host}:${port}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error("Run `local-rtc --help` to see available options.");
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    return;
  }

  if (options.version) {
    console.log(pkg.version);
    return;
  }

  try {
    const instance = await startServer({
      host: options.host,
      port: options.port,
    });

    printAddresses(instance.host, instance.port);
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      console.error(`Error: Port ${options.port} is already in use.`);
    } else if (error && error.code === "EACCES") {
      console.error(`Error: Permission denied when binding to ${options.host}:${options.port}.`);
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exit(1);
  }
}

main();
