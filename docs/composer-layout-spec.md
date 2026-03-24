# Layout Refinement: Composer Status Area

## Goal

The objective is to reorganize the "status area" within the main Composer UI to
create a more logical visual hierarchy.

Currently, the loading state (e.g., "Thinking...") and system indicators (like
toast messages and shell mode) are separated by a horizontal divider. We need to
swap their positions so that the loading indicator is immediately above the
input prompt, and the transient system indicators are moved above the divider.

## Visual Hierarchy Changes

### 1. The "Above Divider" Zone (System Indicators)

The space immediately above the horizontal divider should be reserved for
transient system notifications and mode indicators that contextualize the
_environment_.

- **Toast Messages:** (e.g., "Press Ctrl+C again to exit")
- **Shell Mode Indicator:** (e.g., "Shell Mode")
- **Raw Markdown Indicator**
- _Note: The `ShortcutsHint` remains on the far right of this area._

### 2. The "Below Divider" Zone (Active State)

The space immediately below the horizontal divider (and directly above the input
prompt) should be reserved exclusively for indicating the active processing
state of the application.

- **Loading Indicator:** (e.g., "Thinking...", "Executing...")
- **Status Display:** (e.g., Context usage summary)

## Target Layout Mockup

```text
[ConfigInitDisplay]
[QueuedMessageDisplay]
[TodoTray]

[ToastDisplay | ShellModeIndicator]                    [ShortcutsHint]
----------------------------------------------------------------------
[LoadingIndicator (e.g., Thinking...)]
                                                       [StatusDisplay]

[InputPrompt]
```

## Key Principles for Implementation

- **Keep it Swap-Focused:** This is purely a visual repositioning of existing
  components. No new components need to be created, and no underlying state
  logic needs to be altered.
- **Maintain Alignment:** Ensure that when swapping these components, their
  flexbox or container alignments are preserved (e.g., `ShortcutsHint` stays
  flush right).
- **Responsive Behavior:** The layout must continue to handle narrow terminal
  widths gracefully, stacking components vertically as needed within their new
  respective zones.
