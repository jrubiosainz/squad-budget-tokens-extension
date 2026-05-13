#!/usr/bin/env node
const major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 20) {
  console.error(`✗ Node.js 20+ required. You have v${process.versions.node}.`);
  console.error(`  Upgrade: https://nodejs.org/`);
  process.exit(1);
}

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

const extensionName = "squad-budget-tokens";
const extensionsDir = join(homedir(), ".copilot", "extensions", extensionName);
const sourceFile = join(repoRoot, "src", "extension.mjs");
const targetFile = join(extensionsDir, "extension.mjs");

try {
  // Ensure the extensions directory exists
  mkdirSync(extensionsDir, { recursive: true });

  // Copy the extension file
  copyFileSync(sourceFile, targetFile);

  const action = existsSync(targetFile) ? "installed" : "updated";
  console.log(`✓ squad-budget-tokens extension ${action} successfully!`);
  console.log(`  Location: ${extensionsDir}`);
  console.log(`\nRestart the GitHub Copilot CLI session to activate the extension.`);
  console.log(`The dashboard will appear at http://127.0.0.1:51954/ when running in a Squad workspace.`);
} catch (error) {
  console.error(`✗ Installation failed: ${error.message}`);
  process.exit(1);
}
