/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  type SandboxManager,
  type SandboxRequest,
  type SandboxedCommand,
  GOVERNANCE_FILES,
  type GlobalSandboxOptions,
  sanitizePaths,
  type SandboxPermissions,
} from '../../services/sandboxManager.js';
import {
  sanitizeEnvironment,
  getSecureSanitizationConfig,
  type EnvironmentSanitizationConfig,
} from '../../services/environmentSanitization.js';
import { debugLogger } from '../../utils/debugLogger.js';
import {
  spawnAsync,
  initializeShellParsers,
  stripShellWrapper,
  getCommandRoots,
  splitCommands,
} from '../../utils/shell-utils.js';
import { type SandboxPolicyManager } from '../../policy/sandboxPolicyManager.js';
import { isKnownSafeCommand } from '../macos/commandSafety.js';
import { parse as shellParse } from 'shell-quote';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WindowsSandboxOptions extends GlobalSandboxOptions {
  /** Optional base sanitization config. */
  sanitizationConfig?: EnvironmentSanitizationConfig;
  /** The current sandbox mode behavior from config. */
  modeConfig?: {
    readonly?: boolean;
    network?: boolean;
    approvedTools?: string[];
    allowOverrides?: boolean;
  };
  /** The policy manager for persistent approvals. */
  policyManager?: SandboxPolicyManager;
}

/**
 * A SandboxManager implementation for Windows that uses Restricted Tokens,
 * Job Objects, and Low Integrity levels for process isolation.
 * Uses a native C# helper to bypass PowerShell restrictions.
 */
export class WindowsSandboxManager implements SandboxManager {
  private readonly helperPath: string;
  private initialized = false;
  private readonly lowIntegrityCache = new Set<string>();
  constructor(private readonly options: WindowsSandboxOptions) {
    this.helperPath = path.resolve(__dirname, 'GeminiSandbox.exe');
  }

  private async isStrictlyApproved(req: SandboxRequest): Promise<boolean> {
    const approvedTools = this.options.modeConfig?.approvedTools;
    if (!approvedTools || approvedTools.length === 0) {
      return false;
    }

    await initializeShellParsers();

    const fullCmd = [req.command, ...req.args].join(' ');
    const stripped = stripShellWrapper(fullCmd);

    const roots = getCommandRoots(stripped);
    if (roots.length === 0) return false;

    const allRootsApproved = roots.every((root) =>
      approvedTools.includes(root),
    );
    if (allRootsApproved) {
      return true;
    }

    const pipelineCommands = splitCommands(stripped);
    if (pipelineCommands.length === 0) return false;

    // For safety, every command in the pipeline must be considered safe.
    for (const cmdString of pipelineCommands) {
      const parsedArgs = shellParse(cmdString).map(String);
      if (!isKnownSafeCommand(parsedArgs)) {
        return false;
      }
    }

    return true;
  }

  private async getCommandName(req: SandboxRequest): Promise<string> {
    await initializeShellParsers();
    const fullCmd = [req.command, ...req.args].join(' ');
    const stripped = stripShellWrapper(fullCmd);
    const roots = getCommandRoots(stripped).filter(
      (r) => r !== 'shopt' && r !== 'set',
    );
    if (roots.length > 0) {
      return roots[0];
    }
    return path.basename(req.command);
  }

  /**
 * Ensures a file or directory exists.
...
   */
  private touch(filePath: string, isDirectory: boolean): void {
    try {
      // If it exists (even as a broken symlink), do nothing
      if (fs.lstatSync(filePath)) return;
    } catch {
      // Ignore ENOENT
    }

    if (isDirectory) {
      fs.mkdirSync(filePath, { recursive: true });
    } else {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.closeSync(fs.openSync(filePath, 'a'));
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (os.platform() !== 'win32') {
      this.initialized = true;
      return;
    }

    try {
      if (!fs.existsSync(this.helperPath)) {
        debugLogger.log(
          `WindowsSandboxManager: Helper not found at ${this.helperPath}. Attempting to compile...`,
        );
        // If the exe doesn't exist, we try to compile it from the .cs file
        const sourcePath = this.helperPath.replace(/\.exe$/, '.cs');
        if (fs.existsSync(sourcePath)) {
          const systemRoot = process.env['SystemRoot'] || 'C:\\Windows';
          const cscPaths = [
            'csc.exe', // Try in PATH first
            path.join(
              systemRoot,
              'Microsoft.NET',
              'Framework64',
              'v4.0.30319',
              'csc.exe',
            ),
            path.join(
              systemRoot,
              'Microsoft.NET',
              'Framework',
              'v4.0.30319',
              'csc.exe',
            ),
            // Added newer framework paths
            path.join(
              systemRoot,
              'Microsoft.NET',
              'Framework64',
              'v4.8',
              'csc.exe',
            ),
            path.join(
              systemRoot,
              'Microsoft.NET',
              'Framework',
              'v4.8',
              'csc.exe',
            ),
            path.join(
              systemRoot,
              'Microsoft.NET',
              'Framework64',
              'v3.5',
              'csc.exe',
            ),
          ];

          let compiled = false;
          for (const csc of cscPaths) {
            try {
              debugLogger.log(
                `WindowsSandboxManager: Trying to compile using ${csc}...`,
              );
              // We use spawnAsync but we don't need to capture output
              await spawnAsync(csc, ['/out:' + this.helperPath, sourcePath]);
              debugLogger.log(
                `WindowsSandboxManager: Successfully compiled sandbox helper at ${this.helperPath}`,
              );
              compiled = true;
              break;
            } catch (e) {
              debugLogger.log(
                `WindowsSandboxManager: Failed to compile using ${csc}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }

          if (!compiled) {
            debugLogger.log(
              'WindowsSandboxManager: Failed to compile sandbox helper from any known CSC path.',
            );
          }
        } else {
          debugLogger.log(
            `WindowsSandboxManager: Source file not found at ${sourcePath}. Cannot compile helper.`,
          );
        }
      } else {
        debugLogger.log(
          `WindowsSandboxManager: Found helper at ${this.helperPath}`,
        );
      }
    } catch (e) {
      debugLogger.log(
        'WindowsSandboxManager: Failed to initialize sandbox helper:',
        e,
      );
    }

    this.initialized = true;
  }

  /**
   * Prepares a command for sandboxed execution on Windows.
   */
  async prepareCommand(req: SandboxRequest): Promise<SandboxedCommand> {
    await this.ensureInitialized();

    const sanitizationConfig = getSecureSanitizationConfig(
      req.policy?.sanitizationConfig,
    );

    const sanitizedEnv = sanitizeEnvironment(req.env, sanitizationConfig);

    const isReadonlyMode = this.options.modeConfig?.readonly ?? true;
    const allowOverrides = this.options.modeConfig?.allowOverrides ?? true;

    // Reject override attempts in plan mode
    if (!allowOverrides && req.policy?.additionalPermissions) {
      const perms = req.policy.additionalPermissions;
      if (
        perms.network ||
        (perms.fileSystem?.write && perms.fileSystem.write.length > 0)
      ) {
        throw new Error(
          'Sandbox request rejected: Cannot override readonly/network restrictions in Plan mode.',
        );
      }
    }

    // Fetch persistent approvals for this command
    const commandName = await this.getCommandName(req);
    const persistentPermissions = allowOverrides
      ? this.options.policyManager?.getCommandPermissions(commandName)
      : undefined;

    // Merge all permissions
    const mergedAdditional: SandboxPermissions = {
      fileSystem: {
        read: [
          ...(persistentPermissions?.fileSystem?.read ?? []),
          ...(req.policy?.additionalPermissions?.fileSystem?.read ?? []),
        ],
        write: [
          ...(persistentPermissions?.fileSystem?.write ?? []),
          ...(req.policy?.additionalPermissions?.fileSystem?.write ?? []),
        ],
      },
      network:
        persistentPermissions?.network ||
        req.policy?.additionalPermissions?.network ||
        false,
    };

    // 1. Handle filesystem permissions for Low Integrity
    // Grant "Low Mandatory Level" write access to the workspace.
    // If not in readonly mode OR it's a strictly approved pipeline, allow workspace writes
    const isApproved = allowOverrides
      ? await this.isStrictlyApproved(req)
      : false;

    if (!isReadonlyMode || isApproved) {
      await this.grantLowIntegrityAccess(this.options.workspace);
    }

    // Grant "Low Mandatory Level" read access to allowedPaths.
    const allowedPaths = sanitizePaths(req.policy?.allowedPaths) || [];
    for (const allowedPath of allowedPaths) {
      await this.grantLowIntegrityAccess(allowedPath);
    }

    // Grant "Low Mandatory Level" write access to additional permissions write paths.
    const additionalWritePaths =
      sanitizePaths(mergedAdditional.fileSystem?.write) || [];
    for (const writePath of additionalWritePaths) {
      await this.grantLowIntegrityAccess(writePath);
    }

    // TODO: handle forbidden paths

    // 2. Protected governance files
    // These must exist on the host before running the sandbox to prevent
    // the sandboxed process from creating them with Low integrity.
    // By being created as Medium integrity, they are write-protected from Low processes.
    for (const file of GOVERNANCE_FILES) {
      const filePath = path.join(this.options.workspace, file.path);
      this.touch(filePath, file.isDirectory);

      // We resolve real paths to ensure protection for both the symlink and its target.
      try {
        const realPath = fs.realpathSync(filePath);
        if (realPath !== filePath) {
          // If it's a symlink, the target is already implicitly protected
          // if it's outside the Low integrity workspace (likely Medium).
          // If it's inside, we ensure it's not accidentally Low.
        }
      } catch {
        // Ignore realpath errors
      }
    }

    // 3. Construct the helper command
    // GeminiSandbox.exe <network:0|1> <cwd> <command> [args...]
    const program = this.helperPath;

    const networkAccess =
      this.options.modeConfig?.network ??
      req.policy?.networkAccess ??
      mergedAdditional.network;

    // If the command starts with __, it's an internal command for the sandbox helper itself.
    const args = [networkAccess ? '1' : '0', req.cwd, req.command, ...req.args];

    return {
      program,
      args,
      env: sanitizedEnv,
    };
  }

  /**
   * Grants "Low Mandatory Level" access to a path using icacls.
   */
  private async grantLowIntegrityAccess(targetPath: string): Promise<void> {
    if (os.platform() !== 'win32') {
      return;
    }

    const resolvedPath = path.resolve(targetPath);
    if (this.lowIntegrityCache.has(resolvedPath)) {
      return;
    }

    // Explicitly reject UNC paths to prevent credential theft/SSRF
    if (resolvedPath.startsWith('\\\\')) {
      debugLogger.log(
        'WindowsSandboxManager: Rejecting UNC path for Low Integrity grant:',
        resolvedPath,
      );
      return;
    }

    // Never modify integrity levels for system directories
    const systemRoot = process.env['SystemRoot'] || 'C:\\Windows';
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 =
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    if (
      resolvedPath.toLowerCase().startsWith(systemRoot.toLowerCase()) ||
      resolvedPath.toLowerCase().startsWith(programFiles.toLowerCase()) ||
      resolvedPath.toLowerCase().startsWith(programFilesX86.toLowerCase())
    ) {
      return;
    }

    try {
      await spawnAsync('icacls', [resolvedPath, '/setintegritylevel', 'Low']);
      this.lowIntegrityCache.add(resolvedPath);
    } catch (e) {
      debugLogger.log(
        'WindowsSandboxManager: icacls failed for',
        resolvedPath,
        e,
      );
    }
  }
}
