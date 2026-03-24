/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { ApprovalMode } from '@google/gemini-cli-core';
import { formatCommand } from '../key/keybindingUtils.js';
import { Command } from '../key/keyBindings.js';

interface ApprovalModeIndicatorProps {
  approvalMode: ApprovalMode;
  allowPlanMode?: boolean;
  variant?: 'default' | 'compact';
}

export const ApprovalModeIndicator: React.FC<ApprovalModeIndicatorProps> = ({
  approvalMode,
  allowPlanMode,
  variant = 'default',
}) => {
  let textColor = '';
  let textContent = '';
  let subText = '';

  const cycleHint = formatCommand(Command.CYCLE_APPROVAL_MODE);
  const yoloHint = formatCommand(Command.TOGGLE_YOLO);

  switch (approvalMode) {
    case ApprovalMode.AUTO_EDIT:
      textColor = theme.status.warning;
      textContent = 'auto-accept';
      subText = allowPlanMode
        ? `${cycleHint} to plan`
        : `${cycleHint} to manual`;
      break;
    case ApprovalMode.PLAN:
      textColor = theme.status.success;
      textContent = 'plan';
      subText = `${cycleHint} to manual`;
      break;
    case ApprovalMode.YOLO:
      textColor = theme.status.error;
      textContent = 'YOLO';
      subText = yoloHint;
      break;
    case ApprovalMode.DEFAULT:
    default:
      textColor = theme.text.accent;
      textContent = variant === 'compact' ? 'manual' : '';
      subText = `${cycleHint} to accept edits`;
      break;
  }

  if (variant === 'compact') {
    return <Text color={textColor}>{textContent}</Text>;
  }

  return (
    <Box>
      <Text color={textColor}>
        {textContent ? textContent : null}
        {subText ? (
          <Text color={theme.text.secondary}>
            {textContent ? ' ' : ''}
            {subText}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
};
