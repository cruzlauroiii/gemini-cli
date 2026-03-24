/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WindowsSandboxManager } from './WindowsSandboxManager.js';
import type { SandboxRequest } from '../../services/sandboxManager.js';
import { spawnAsync } from '../../utils/shell-utils.js';
import type { SandboxPolicyManager } from '../../policy/sandboxPolicyManager.js';

vi.mock('../../utils/shell-utils.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../utils/shell-utils.js')
  >('../../utils/shell-utils.js');
  return {
    ...actual,
    spawnAsync: vi.fn(),
    initializeShellParsers: vi.fn(),
  };
});

describe('WindowsSandboxManager', () => {
  let manager: WindowsSandboxManager;
  let testCwd: string;

  beforeEach(() => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-test-'));
    manager = new WindowsSandboxManager({
      workspace: testCwd,
      modeConfig: { readonly: false, allowOverrides: true },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testCwd, { recursive: true, force: true });
  });

  it('should prepare a GeminiSandbox.exe command', async () => {
    const req: SandboxRequest = {
      command: 'whoami',
      args: ['/groups'],
      cwd: testCwd,
      env: { TEST_VAR: 'test_value' },
      policy: {
        networkAccess: false,
      },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toContain('GeminiSandbox.exe');
    expect(result.args).toEqual(['0', testCwd, 'whoami', '/groups']);
  });

  it('should handle networkAccess from config', async () => {
    const req: SandboxRequest = {
      command: 'whoami',
      args: [],
      cwd: testCwd,
      env: {},
      policy: {
        networkAccess: true,
      },
    };

    const result = await manager.prepareCommand(req);
    expect(result.args[0]).toBe('1');
  });

  it('should handle network access from additionalPermissions', async () => {
    const req: SandboxRequest = {
      command: 'whoami',
      args: [],
      cwd: testCwd,
      env: {},
      policy: {
        additionalPermissions: {
          network: true,
        },
      },
    };

    const result = await manager.prepareCommand(req);
    expect(result.args[0]).toBe('1');
  });

  it('should reject network access in Plan mode', async () => {
    const planManager = new WindowsSandboxManager({
      workspace: testCwd,
      modeConfig: { readonly: true, allowOverrides: false },
    });
    const req: SandboxRequest = {
      command: 'curl',
      args: ['google.com'],
      cwd: testCwd,
      env: {},
      policy: {
        additionalPermissions: { network: true },
      },
    };

    await expect(planManager.prepareCommand(req)).rejects.toThrow(
      'Sandbox request rejected: Cannot override readonly/network restrictions in Plan mode.',
    );
  });

  it('should handle persistent permissions from policyManager', async () => {
    const persistentPath = path.resolve('/persistent/path');
    const mockPolicyManager = {
      getCommandPermissions: vi.fn().mockReturnValue({
        fileSystem: { write: [persistentPath] },
        network: true,
      }),
    } as unknown as SandboxPolicyManager;

    const managerWithPolicy = new WindowsSandboxManager({
      workspace: testCwd,
      modeConfig: { allowOverrides: true },
      policyManager: mockPolicyManager,
    });

    const req: SandboxRequest = {
      command: 'test-cmd',
      args: [],
      cwd: testCwd,
      env: {},
    };

    const result = await managerWithPolicy.prepareCommand(req);
    expect(result.args[0]).toBe('1'); // Network allowed by persistent policy

    // Use filter to skip potential csc.exe compiler calls in test environment
    const icaclsArgs = vi
      .mocked(spawnAsync)
      .mock.calls.filter((c) => c[0] === 'icacls')
      .map((c) => c[1]);

    expect(icaclsArgs).toContainEqual([
      persistentPath,
      '/setintegritylevel',
      'Low',
    ]);
  });

  it('should sanitize environment variables', async () => {
    const req: SandboxRequest = {
      command: 'test',
      args: [],
      cwd: testCwd,
      env: {
        API_KEY: 'secret',
        PATH: '/usr/bin',
      },
      policy: {
        sanitizationConfig: {
          allowedEnvironmentVariables: ['PATH'],
          blockedEnvironmentVariables: ['API_KEY'],
          enableEnvironmentVariableRedaction: true,
        },
      },
    };

    const result = await manager.prepareCommand(req);
    expect(result.env['PATH']).toBe('/usr/bin');
    expect(result.env['API_KEY']).toBeUndefined();
  });

  it('should ensure governance files exist', async () => {
    const req: SandboxRequest = {
      command: 'test',
      args: [],
      cwd: testCwd,
      env: {},
    };

    await manager.prepareCommand(req);

    expect(fs.existsSync(path.join(testCwd, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(testCwd, '.geminiignore'))).toBe(true);
    expect(fs.existsSync(path.join(testCwd, '.git'))).toBe(true);
    expect(fs.lstatSync(path.join(testCwd, '.git')).isDirectory()).toBe(true);
  });

  it('should grant Low Integrity access to the workspace and allowed paths', async () => {
    const allowedPath = path.join(os.tmpdir(), 'gemini-cli-test-allowed');
    if (!fs.existsSync(allowedPath)) {
      fs.mkdirSync(allowedPath);
    }
    try {
      const req: SandboxRequest = {
        command: 'test',
        args: [],
        cwd: testCwd,
        env: {},
        policy: {
          allowedPaths: [allowedPath],
        },
      };

      await manager.prepareCommand(req);

      const icaclsArgs = vi
        .mocked(spawnAsync)
        .mock.calls.filter((c) => c[0] === 'icacls')
        .map((c) => c[1]);

      expect(icaclsArgs).toContainEqual([
        path.resolve(testCwd),
        '/setintegritylevel',
        'Low',
      ]);

      expect(icaclsArgs).toContainEqual([
        path.resolve(allowedPath),
        '/setintegritylevel',
        'Low',
      ]);
    } finally {
      fs.rmSync(allowedPath, { recursive: true, force: true });
    }
  });

  it('should grant Low Integrity access to additional write paths', async () => {
    const extraWritePath = path.join(
      os.tmpdir(),
      'gemini-cli-test-extra-write',
    );
    if (!fs.existsSync(extraWritePath)) {
      fs.mkdirSync(extraWritePath);
    }
    try {
      const req: SandboxRequest = {
        command: 'test',
        args: [],
        cwd: testCwd,
        env: {},
        policy: {
          additionalPermissions: {
            fileSystem: {
              write: [extraWritePath],
            },
          },
        },
      };

      await manager.prepareCommand(req);

      const icaclsArgs = vi
        .mocked(spawnAsync)
        .mock.calls.filter((c) => c[0] === 'icacls')
        .map((c) => c[1]);

      expect(icaclsArgs).toContainEqual([
        path.resolve(extraWritePath),
        '/setintegritylevel',
        'Low',
      ]);
    } finally {
      fs.rmSync(extraWritePath, { recursive: true, force: true });
    }
  });

  it('should reject UNC paths in grantLowIntegrityAccess', async () => {
    const uncPath = '\\\\attacker\\share\\malicious.txt';
    const req: SandboxRequest = {
      command: 'test',
      args: [],
      cwd: testCwd,
      env: {},
      policy: {
        additionalPermissions: {
          fileSystem: {
            write: [uncPath],
          },
        },
      },
    };

    const isAbsoluteSpy = vi.spyOn(path, 'isAbsolute').mockReturnValue(true);

    await manager.prepareCommand(req);

    const icaclsArgs = vi
      .mocked(spawnAsync)
      .mock.calls.filter((c) => c[0] === 'icacls')
      .map((c) => c[1]);

    expect(icaclsArgs).not.toContainEqual([
      uncPath,
      '/setintegritylevel',
      'Low',
    ]);

    isAbsoluteSpy.mockRestore();
  });
});
