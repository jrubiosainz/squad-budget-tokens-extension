#!/usr/bin/env node
const major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 20) {
  console.error(`✗ Node.js 20+ required. You have v${process.versions.node}.`);
  console.error(`  Upgrade: https://nodejs.org/`);
  process.exit(1);
}

import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const extensionName = "squad-budget-tokens";
const extensionsDir = join(homedir(), ".copilot", "extensions", extensionName);

try {
  if (existsSync(extensionsDir)) {
    rmSync(extensionsDir, { recursive: true, force: true });
    console.log(`✓ squad-budget-tokens extension uninstalled successfully.`);
    console.log(`  Removed: ${extensionsDir}`);
  } else {
    console.log(`ℹ squad-budget-tokens extension was not installed.`);
    console.log(`  Expected location: ${extensionsDir}`);
  }
} catch (error) {
  console.error(`✗ Uninstallation failed: ${error.message}`);
  process.exit(1);
}
