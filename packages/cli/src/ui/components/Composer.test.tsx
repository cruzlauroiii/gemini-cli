/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render } from '../../test-utils/render.js';
import { act, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Composer } from './Composer.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { createMockSettings } from '../../test-utils/settings.js';
import type { Config } from '@google/gemini-cli-core';
import { StreamingState } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { SessionMetrics } from '../contexts/SessionContext.js';
import type { TextBuffer } from './shared/text-buffer.js';

// Mock VimModeContext hook
vi.mock('../contexts/VimModeContext.js', () => ({
  useVimMode: vi.fn(() => ({
    vimEnabled: false,
    vimMode: 'INSERT',
  })),
}));

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({
    columns: 100,
    rows: 24,
  })),
}));

const composerTestControls = vi.hoisted(() => ({
  suggestionsVisible: false,
  isAlternateBuffer: false,
}));

// Mock child components
vi.mock('./LoadingIndicator.js', () => ({
  LoadingIndicator: ({
    thought,
    thoughtLabel,
  }: {
    thought?: { subject?: string } | string;
    thoughtLabel?: string;
  }) => {
    const fallbackText =
      typeof thought === 'string' ? thought : thought?.subject;
    const text = thoughtLabel ?? fallbackText;
    return <Text>LoadingIndicator{text ? `: ${text}` : ''}</Text>;
  },
}));

vi.mock('./StatusDisplay.js', () => ({
  StatusDisplay: ({ hideContextSummary }: { hideContextSummary: boolean }) => (
    <Text>StatusDisplay{hideContextSummary ? ' (hidden summary)' : ''}</Text>
  ),
}));

vi.mock('./ContextSummaryDisplay.js', () => ({
  ContextSummaryDisplay: () => <Text>ContextSummaryDisplay</Text>,
}));

vi.mock('./HookStatusDisplay.js', () => ({
  HookStatusDisplay: () => <Text>HookStatusDisplay</Text>,
}));

vi.mock('./ShellModeIndicator.js', () => ({
  ShellModeIndicator: () => <Text>ShellModeIndicator</Text>,
}));

vi.mock('./ShortcutsHelp.js', () => ({
  ShortcutsHelp: () => <Text>ShortcutsHelp</Text>,
}));

vi.mock('./DetailedMessagesDisplay.js', () => ({
  DetailedMessagesDisplay: () => <Text>DetailedMessagesDisplay</Text>,
}));

vi.mock('./InputPrompt.js', () => ({
  InputPrompt: (props: any) => {
    useEffect(() => {
      props.onSuggestionsVisibilityChange?.(
        composerTestControls.suggestionsVisible,
      );
    }, [props.onSuggestionsVisibilityChange]);
    return <Text>InputPrompt: {props.placeholder}</Text>;
  },
}));

vi.mock('./Footer.js', () => ({
  Footer: () => <Text>Footer</Text>,
}));

vi.mock('./ShowMoreLines.js', () => ({
  ShowMoreLines: () => <Text>ShowMoreLines</Text>,
}));

vi.mock('./QueuedMessageDisplay.js', () => ({
  QueuedMessageDisplay: ({ messageQueue }: { messageQueue: string[] }) => {
    if (messageQueue.length === 0) {
      return null;
    }
    return (
      <>
        {messageQueue.map((message, index) => (
          <Text key={index}>{message}</Text>
        ))}
      </>
    );
  },
}));

vi.mock('./RawMarkdownIndicator.js', () => ({
  RawMarkdownIndicator: () => <Text>RawMarkdownIndicator</Text>,
}));

vi.mock('./ShortcutsHint.js', () => ({
  ShortcutsHint: () => <Text>ShortcutsHint</Text>,
}));

vi.mock('./ToastDisplay.js', () => ({
  ToastDisplay: () => <Text>ToastDisplay</Text>,
  shouldShowToast: vi.fn(
    (uiState: UIState) =>
      uiState.ctrlCPressedOnce ||
      uiState.ctrlDPressedOnce ||
      uiState.showEscapePrompt ||
      uiState.transientMessage,
  ),
}));

vi.mock('../utils/ui-sizing.js', () => ({
  isNarrowWidth: vi.fn((width: number) => width < 60),
  isContextUsageHigh: vi.fn(() => false),
  shouldShowToast: vi.fn(
    (uiState: UIState) =>
      uiState.ctrlCPressedOnce ||
      uiState.ctrlDPressedOnce ||
      uiState.showEscapePrompt ||
      uiState.transientMessage,
  ),
}));

vi.mock('../hooks/useAlternateBuffer.js', () => ({
  useAlternateBuffer: vi.fn(() => composerTestControls.isAlternateBuffer),
}));

vi.mock('../hooks/useShortcutsHintDebounce.js', () => ({
  useShortcutsHintDebounce: vi.fn(() => true),
}));

const mockConfig = {
  getDebugMode: vi.fn(() => false),
  getTerminalBackground: vi.fn(() => 'dark'),
} as unknown as Config;

const createMockUIState = (overrides: Partial<UIState> = {}): UIState =>
  ({
    streamingState: StreamingState.Idle,
    isConfigInitialized: true,
    contextFileNames: [],
    showApprovalModeIndicator: 0 as any, // Default mode
    messageQueue: [],
    showErrorDetails: false,
    constrainHeight: false,
    isInputActive: true,
    buffer: { text: '' },
    inputWidth: 80,
    suggestionsWidth: 40,
    userMessages: [],
    slashCommands: [],
    commandContext: null,
    shellModeActive: false,
    isFocused: true,
    thought: { subject: '', description: '' },
    currentLoadingPhrase: '',
    elapsedTime: 0,
    terminalWidth: 100,
    activeHooks: [],
    currentTip: '',
    currentWittyPhrase: '',
    shortcutsHelpVisible: false,
    cleanUiDetailsVisible: true,
    shortcutsHintVisible: true,
    ctrlCPressedOnce: false,
    ctrlDPressedOnce: false,
    showEscapePrompt: false,
    history: [],
    sessionStats: {
      sessionId: 'test-session',
      sessionStartTime: new Date(),
      metrics: {} as SessionMetrics,
      lastPromptTokenCount: 0,
      promptCount: 0,
    },
    quota: {
      stats: null,
      proQuotaRequest: null,
      validationRequest: null,
    },
    isResuming: false,
    embeddedShellFocused: false,
    isBackgroundShellVisible: false,
    ...overrides,
  }) as unknown as UIState;

const renderComposer = async (
  uiState: UIState,
  settings: LoadedSettings = createMockSettings(),
) => {
  const uiActions: Partial<UIActions> = {
    setShortcutsHelpVisible: vi.fn(),
    handleFinalSubmit: vi.fn(),
    setBannerVisible: vi.fn(),
    handleClearScreen: vi.fn(),
    setShellModeActive: vi.fn(),
    onEscapePromptChange: vi.fn(),
    vimHandleInput: vi.fn(),
    popAllMessages: vi.fn(),
    setQueueErrorMessage: vi.fn(),
  };

  const renderResult = await render(
    <ConfigContext.Provider value={mockConfig}>
      <SettingsContext.Provider value={settings}>
        <UIStateContext.Provider value={uiState}>
          <UIActionsContext.Provider value={uiActions as UIActions}>
            <Composer />
          </UIActionsContext.Provider>
        </UIStateContext.Provider>
      </SettingsContext.Provider>
    </ConfigContext.Provider>,
  );

  return {
    ...renderResult,
    uiActions,
  };
};

describe('Composer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    composerTestControls.suggestionsVisible = false;
    composerTestControls.isAlternateBuffer = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Footer Display Settings', () => {
    it('renders Footer by default when hideFooter is false', async () => {
      const uiState = createMockUIState();
      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).toContain('Footer');
    });

    it('does NOT render Footer when hideFooter is true', async () => {
      const uiState = createMockUIState();
      const settings = createMockSettings({
        ui: { hideFooter: true },
      });

      const { lastFrame } = await renderComposer(uiState, settings);

      expect(lastFrame()).not.toContain('Footer');
    });
  });

  describe('Loading Indicator', () => {
    it('renders LoadingIndicator with thought when streaming', async () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        thought: {
          subject: 'Thinking',
          description: '',
        },
      });

      const { lastFrame } = await renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('LoadingIndicator: Thinking');
    });

    it('renders LoadingIndicator when streaming in full UI mode', async () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        thought: {
          subject: 'Thinking',
          description: '',
        },
      });

      const { lastFrame } = await renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('LoadingIndicator: Thinking');
    });

    it('does NOT render LoadingIndicator when embedded shell is focused and background shell is NOT visible', async () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        embeddedShellFocused: true,
        isBackgroundShellVisible: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      const output = lastFrame();
      expect(output).not.toContain('LoadingIndicator');
    });
  });

  describe('Message Queue Display', () => {
    it('displays queued messages when present', async () => {
      const uiState = createMockUIState({
        messageQueue: [
          'First queued message',
          'Second queued message',
          'Third queued message',
        ],
      });

      const { lastFrame } = await renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('First queued message');
      expect(output).toContain('Second queued message');
      expect(output).toContain('Third queued message');
    });

    it('renders QueuedMessageDisplay with empty message queue', async () => {
      const uiState = createMockUIState({
        messageQueue: [],
      });

      const { lastFrame } = await renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('InputPrompt'); // Verify basic Composer rendering
    });
  });

  describe('Context and Status Display', () => {
    it('shows StatusDisplay in normal state', async () => {
      const uiState = createMockUIState({
        ctrlCPressedOnce: false,
        ctrlDPressedOnce: false,
        showEscapePrompt: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('StatusDisplay');
      expect(output).not.toContain('ToastDisplay');
    });

    it('shows ToastDisplay when a toast is present', async () => {
      const uiState = createMockUIState({
        ctrlCPressedOnce: true,
      });

      const { lastFrame } = await renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('ToastDisplay');
      expect(output).toContain('StatusDisplay');
    });
  });

  describe('Input and Indicators', () => {
    it('hides non-essential UI details in clean mode', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
      });
      const settings = createMockSettings({
        ui: { showShortcutsHint: false },
      });

      const { lastFrame } = await renderComposer(uiState, settings);

      const output = lastFrame();
      expect(output).not.toContain('press tab twice for more');
      expect(output).not.toContain('? for shortcuts');
    });

    it('renders InputPrompt when input is active', async () => {
      const uiState = createMockUIState({ isInputActive: true });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).toContain('InputPrompt');
    });

    it('does not render InputPrompt when input is inactive', async () => {
      const uiState = createMockUIState({ isInputActive: false });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).not.toContain('InputPrompt');
    });

    it('shows ShellModeIndicator when shell mode is active', async () => {
      const uiState = createMockUIState({
        shellModeActive: true,
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).toMatch(/ShellModeIndicator/);
    });

    it('shows RawMarkdownIndicator when renderMarkdown is false', async () => {
      const uiState = createMockUIState({
        renderMarkdown: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).toContain('RawMarkdownIndicator');
    });

    it('does not show RawMarkdownIndicator when renderMarkdown is true', async () => {
      const uiState = createMockUIState({
        renderMarkdown: true,
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).not.toContain('RawMarkdownIndicator');
    });

    it('shows Esc rewind prompt in minimal mode without showing full UI', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
        showEscapePrompt: true,
        history: [{ id: 1, type: 'user', text: 'msg' }],
      });

      const { lastFrame } = await renderComposer(uiState);
      const output = lastFrame();
      expect(output).toContain('ToastDisplay');
      expect(output).not.toContain('ContextSummaryDisplay');
    });
  });

  describe('Error Details Display', () => {
    it('shows DetailedMessagesDisplay when showErrorDetails is true', async () => {
      const uiState = createMockUIState({
        showErrorDetails: true,
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).toContain('DetailedMessagesDisplay');
      expect(lastFrame()).toContain('ShowMoreLines');
    });

    it('does not show error details when showErrorDetails is false', async () => {
      const uiState = createMockUIState({
        showErrorDetails: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).not.toContain('DetailedMessagesDisplay');
    });
  });

  describe('Vim Mode Placeholders', () => {
    it('shows correct placeholder in INSERT mode', async () => {
      const uiState = createMockUIState({ isInputActive: true });
      const { useVimMode } = await import('../contexts/VimModeContext.js');
      vi.mocked(useVimMode).mockReturnValue({
        vimEnabled: true,
        vimMode: 'INSERT',
        toggleVimEnabled: vi.fn(),
        setVimMode: vi.fn(),
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).toContain(
        "InputPrompt:   Press 'Esc' for NORMAL mode.",
      );
    });

    it('shows correct placeholder in NORMAL mode', async () => {
      const uiState = createMockUIState({ isInputActive: true });
      const { useVimMode } = await import('../contexts/VimModeContext.js');
      vi.mocked(useVimMode).mockReturnValue({
        vimEnabled: true,
        vimMode: 'NORMAL',
        toggleVimEnabled: vi.fn(),
        setVimMode: vi.fn(),
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).toContain(
        "InputPrompt:   Press 'i' for INSERT mode.",
      );
    });
  });

  describe('Shortcuts Hint', () => {
    it('restores shortcuts hint after 200ms debounce when buffer is empty', async () => {
      const uiState = createMockUIState({
        buffer: { text: '' } as unknown as TextBuffer,
        cleanUiDetailsVisible: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(lastFrame({ allowEmpty: true })).toContain(
        'press tab twice for more',
      );
    });

    it('hides shortcuts hint when text is typed in buffer', async () => {
      const uiState = createMockUIState({
        buffer: { text: 'hello' } as unknown as TextBuffer,
        cleanUiDetailsVisible: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).not.toContain('press tab twice for more');
      expect(lastFrame()).not.toContain('? for shortcuts');
    });

    it('hides shortcuts hint when showShortcutsHint setting is false', async () => {
      const uiState = createMockUIState();
      const settings = createMockSettings({
        ui: {
          showShortcutsHint: false,
        },
      });

      const { lastFrame } = await renderComposer(uiState, settings);

      expect(lastFrame()).not.toContain('? for shortcuts');
    });

    it('hides shortcuts hint when a action is required (e.g. dialog is open)', async () => {
      const uiState = createMockUIState({
        customDialog: (
          <Box>
            <Text>Test Dialog</Text>
            <Text>Test Content</Text>
          </Box>
        ),
      });

      const { lastFrame, unmount } = await renderComposer(uiState);

      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });

    it('keeps shortcuts hint visible when no action is required', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(lastFrame()).toContain('press tab twice for more');
    });

    it('shows shortcuts hint when full UI details are visible', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: true,
      });

      const { lastFrame } = await renderComposer(uiState);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      // In experimental layout, status row is visible and contains shortcuts hint
      expect(lastFrame()).toContain('? for shortcuts');
    });

    it('shows shortcuts hint while loading when full UI details are visible', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: true,
        streamingState: StreamingState.Responding,
      });

      const { lastFrame } = await renderComposer(uiState);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(lastFrame()).toContain('LoadingIndicator');
      expect(lastFrame()).toContain('? for shortcuts');
      expect(lastFrame()).not.toContain('press tab twice for more');
    });

    it('shows shortcuts hint while loading in minimal mode', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
        streamingState: StreamingState.Responding,
        elapsedTime: 1,
      });

      const { lastFrame } = await renderComposer(uiState);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(lastFrame()).toContain('LoadingIndicator');
      expect(lastFrame()).toContain('press tab twice for more');
      expect(lastFrame()).not.toContain('? for shortcuts');
    });

    it('shows shortcuts help in minimal mode when toggled on', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
        shortcutsHelpVisible: true,
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).toContain('ShortcutsHelp');
    });

    it('hides shortcuts hint when suggestions are visible above input in alternate buffer', async () => {
      composerTestControls.isAlternateBuffer = true;
      composerTestControls.suggestionsVisible = true;

      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      expect(lastFrame()).not.toContain('press tab twice for more');
      expect(lastFrame()).not.toContain('? for shortcuts');
    });

    it('keeps shortcuts hint when suggestions are visible below input in regular buffer', async () => {
      composerTestControls.isAlternateBuffer = false;
      composerTestControls.suggestionsVisible = true;

      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
      });

      const { lastFrame } = await renderComposer(uiState);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(lastFrame()).toContain('press tab twice for more');
    });
  });

  describe('Shortcuts Help', () => {
    it('shows shortcuts help in passive state', async () => {
      const uiState = createMockUIState({
        shortcutsHelpVisible: true,
        streamingState: StreamingState.Idle,
      });

      const { lastFrame, unmount } = await renderComposer(uiState);

      expect(lastFrame()).toContain('ShortcutsHelp');
      unmount();
    });

    it('hides shortcuts help while streaming', async () => {
      const uiState = createMockUIState({
        shortcutsHelpVisible: true,
        streamingState: StreamingState.Responding,
      });

      const { lastFrame, unmount } = await renderComposer(uiState);

      expect(lastFrame()).not.toContain('ShortcutsHelp');
      unmount();
    });
    it('hides shortcuts help when action is required', async () => {
      const uiState = createMockUIState({
        shortcutsHelpVisible: true,
        customDialog: (
          <Box>
            <Text>Test Dialog</Text>
          </Box>
        ),
      });

      const { lastFrame, unmount } = await renderComposer(uiState);

      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });
  });
  describe('Snapshots', () => {
    it('matches snapshot in idle state', async () => {
      const uiState = createMockUIState();
      const { lastFrame } = await renderComposer(uiState);
      expect(lastFrame()).toMatchSnapshot();
    });

    it('matches snapshot while streaming', async () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        thought: {
          subject: 'Thinking',
          description: 'Thinking about the meaning of life...',
        },
      });
      const { lastFrame } = await renderComposer(uiState);
      expect(lastFrame()).toMatchSnapshot();
    });

    it('matches snapshot in narrow view', async () => {
      const uiState = createMockUIState({
        terminalWidth: 40,
      });
      const { lastFrame } = await renderComposer(uiState);
      expect(lastFrame()).toMatchSnapshot();
    });

    it('matches snapshot in minimal UI mode', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
      });
      const { lastFrame } = await renderComposer(uiState);
      expect(lastFrame()).toMatchSnapshot();
    });

    it('matches snapshot in minimal UI mode while loading', async () => {
      const uiState = createMockUIState({
        cleanUiDetailsVisible: false,
        streamingState: StreamingState.Responding,
        elapsedTime: 1000,
      });
      const { lastFrame } = await renderComposer(uiState);
      expect(lastFrame()).toMatchSnapshot();
    });
  });
});
