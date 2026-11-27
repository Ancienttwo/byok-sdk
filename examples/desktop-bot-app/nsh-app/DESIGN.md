# BYOK Bots Desktop UI — Design Standards (`nsh-app`)

This document defines the design system for the NSH Mixed desktop frontend of `examples/desktop-bot-app` (`macOS`, `Windows`, `Linux`). It follows the NSH Design and Coding Guides (`nsh-design-guides`, `nsh`). Every feature screen and `src/ui/` primitive reads from these tokens and rules.

---

## 1. Target Platforms & Interaction Posture

- **Supported targets**: Desktop only — **macOS** (AppKit), **Windows**, **Linux** (GTK4). Mobile and TUI targets are out of scope for this app.
- **Window constraints**: Minimum comfortable content baseline `840 × 560` pt (`default` sidebar width `224` pt / `w-56`, main content workspace absorbs surplus).
- **Input & focus**: Pointer and keyboard first.
  - Every clickable control shows an intentional hover wash and pressed response without layout shift.
  - Every focusable control exposes a clear `focus-visible:` ring using `ring-ring` / `ring-offset-background`.
  - Default cursor on buttons (never `cursor-pointer` on application action buttons); `cursor-pointer` is reserved strictly for URL links.
  - Dialogs, alert dialogs, sheets, menus, and popovers dismiss on `Escape` and manage focus cleanly.
- **Desktop density scale**:
  - `sm` (compact toolbars / inline badges): `24` pt height (`h-6`), compact horizontal padding (`px-2.5`), `12` pt text (`text-xs`), `14` pt icons.
  - `md` (default desktop controls): `32` pt height (`h-8`), `px-3`, `14` pt body text (`text-sm`), `16` pt icons.
  - `lg` (prominent actions / primary composers): `36` pt height (`h-9`), `px-4`, `14`–`16` pt text, `16` pt icons.
  - List rows: `28`–`36` pt comfortable desktop rhythm.

---

## 2. Visual Language, Alignment & Geometry

- **iOS inset grouped hierarchy (no brand color)**: The public desktop edition carries no brand palette. The canvas uses `systemGroupedBackground` (`bg-background`), and inset grouped sections (`Card` / `Surface` / `Disclosure`) sit flat on `secondarySystemGroupedBackground` (`bg-card`) with **no outer stroke** and no drop shadows. Hairline `separator` (`border-border`) dividers apply only inside sections, along sidebar edges, on input frames, and around elevated overlays (`Popover`, `Menu`, `Dialog`, `Sheet`, `Toast`).
- **iOS component defaults & concentric radii**:
  - Base `--radius` is `0.625rem` (`10` pt) for inset grouped sections (`Card`, `Surface`, `Disclosure`, `Empty`), standard/large buttons, inputs, and overlays.
  - Nested inset controls use concentric tighter radii (`rounded-lg`, `8` pt for list rows and segmented-control track; `rounded-md`, `6` pt for segmented-control thumb, menu/select rows, and compact `sm` buttons). Circular switches, badges, and avatars use `rounded-full`.
  - Grouped list rows (`ListItem`) keep a `44` pt minimum height (`min-h-11`).
  - Toggle switches (`Switch`) render borderless pills with `systemFill` off tracks, `systemGreen` (`bg-success`) on tracks, and white thumbs (`bg-success-foreground`).
  - Segmented controls (`Tabs`) render borderless `systemFill` (`bg-muted`) tracks with a sliding `bg-segmented-thumb` (`#ffffff` light / `#636366` `systemGray2` dark) indicator and semibold active labels.
  - Filled buttons (`Button` `primary` in `systemBlue`, `danger` in `systemRed`) render borderless with the iOS filled-button text weight (`font-semibold`).
- **Semantic spacing scale**: Use Tailwind spacing steps exclusively (`gap-0.5` = `2` pt, `gap-1` = `4` pt, `gap-2` = `8` pt, `gap-3` = `12` pt, `gap-4` = `16` pt, `gap-6` = `24` pt, `gap-8` = `32` pt). No arbitrary point classes (`p-[13px]`, `text-[15px]`) in components or pages.
- **Alignment spines**: Sibling sections share leading content insets (`p-6` page canvas, `p-4` card/panel padding). Form fields align along a consistent label -> control -> helper/error vertical spine.
- **Fit at the minimum width**: Every row fits its card at the `840` pt minimum window. In a row of text next to actions or a badge, the text side takes `flex-1` (a text column also takes `min-w-0`) so its text wraps and the actions keep their natural width. A table column that holds a badge takes a fixed Tailwind width with `shrink-0` (`w-36 shrink-0`) on its header and on every cell, so the badge fits and the columns stay aligned.
- **UI layer isolation**: Feature screens and `App.tsx` compose exclusively from `src/ui/` plus layout primitives (`View`, `Text`, `Scroll`, `List`) from `"nsh"`. Pages never import `"nsh/base"` controls directly, never embed raw hex/RGB/HSL literals or palette classes (`bg-zinc-*`, `bg-blue-*`), and never invent one-off control heights or radii.

---

## 3. Semantic Theme Tokens (`nsh.json` `"theme"`)

All colors below are declared once in `nsh.json` (`theme.cssVars`) as static `light` and `dark` iOS system-palette sets — no brand hexes, no custom tweaks, and no runtime system-accent lookup — and consumed strictly via semantic tokens (`bg-*`, `text-*`, `border-*`, `ring-*`, `token(...)`). Appearance defaults to `"system"` (`store.ts`) and switches exclusively through `store.setAppearance` → NSH `setColorScheme(mode)`. State never relies on color alone — every status indicator pairs color with an explicit text label and distinct symbol/glyph.

| Token Role | iOS Semantic Source | Usage | Light | Dark |
| --- | --- | --- | --- | --- |
| `radius` | Inset grouped default | Base section / control radius | `0.625rem` (`10` pt) | `0.625rem` (`10` pt) |
| `background` / `foreground` | `systemGroupedBackground` / `label` | Primary app canvas & primary text | `#f2f2f7` / `#000000` | `#000000` / `#ffffff` |
| `card` / `card-foreground` | `secondarySystemGroupedBackground` / `label` | Inset grouped sections & cards (no stroke) | `#ffffff` / `#000000` | `#1c1c1e` / `#ffffff` |
| `popover` / `popover-foreground` | `secondarySystemGroupedBackground` (elevated) / `label` | Elevated menus, popovers, dialogs, tooltips | `#ffffff` / `#000000` | `#2c2c2e` / `#ffffff` |
| `primary` / `primary-foreground` | `systemBlue` / white | Filled primary CTAs, active tint, focus ring | `#007aff` / `#ffffff` | `#0a84ff` / `#ffffff` |
| `secondary` / `secondary-foreground` | `systemFill` / `label` | Quiet actions, neutral pills | `rgba(120, 120, 128, 0.2)` / `#000000` | `rgba(120, 120, 128, 0.36)` / `#ffffff` |
| `muted` / `muted-foreground` | `systemFill` / `secondaryLabel` | Subtle wells, switch off track, captions | `rgba(120, 120, 128, 0.2)` / `rgba(60, 60, 67, 0.6)` | `rgba(120, 120, 128, 0.36)` / `rgba(235, 235, 245, 0.6)` |
| `tertiary-foreground` | `tertiaryLabel` | Input & select placeholder text | `rgba(60, 60, 67, 0.3)` | `rgba(235, 235, 245, 0.3)` |
| `accent` / `accent-foreground` | `systemFill` / `label` | Hovered / focused rows & menu items | `rgba(120, 120, 128, 0.2)` / `#000000` | `rgba(120, 120, 128, 0.36)` / `#ffffff` |
| `destructive` / `destructive-foreground` | `systemRed` / white | Destructive actions & validation errors | `#ff3b30` / `#ffffff` | `#ff453a` / `#ffffff` |
| `success` / `success-foreground` | `systemGreen` / white | Switch on track, verified confirmations | `#34c759` / `#ffffff` | `#30d158` / `#ffffff` |
| `warning` / `warning-foreground` | `systemOrange` / white | Cautions & degraded states | `#ff9500` / `#ffffff` | `#ff9f0a` / `#ffffff` |
| `border` / `input` / `ring` | `separator` / `separator` / `systemBlue` | Hairline dividers, control frames, focus ring | `rgba(60, 60, 67, 0.29)` / `rgba(60, 60, 67, 0.29)` / `#007aff` | `rgba(84, 84, 88, 0.6)` / `rgba(84, 84, 88, 0.6)` / `#0a84ff` |
| `segmented-thumb` | `secondarySystemGroupedBackground` / `systemGray2` | Native segmented-control sliding thumb | `#ffffff` | `#636366` |
| `chart-1` .. `chart-5` | `systemBlue` / `systemGreen` / `systemOrange` / `systemRed` / `secondaryLabel` | Data series tokens (iOS semantic) | `#007aff` / `#34c759` / `#ff9500` / `#ff3b30` / `rgba(60, 60, 67, 0.6)` | `#0a84ff` / `#30d158` / `#ff9f0a` / `#ff453a` / `rgba(235, 235, 245, 0.6)` |
| `sidebar*` | `secondarySystemGroupedBackground` / `label` / `systemBlue` / `systemFill` / `separator` | Persistent sidebar chrome & active item | `#ffffff` / `#000000` / `#007aff` / `rgba(120, 120, 128, 0.2)` / `rgba(60, 60, 67, 0.29)` | `#1c1c1e` / `#ffffff` / `#0a84ff` / `rgba(120, 120, 128, 0.36)` / `rgba(84, 84, 88, 0.6)` |
| `badge-primary` / `-success` / `-warning` / `-danger` | `systemBlue` / `systemGreen` / `systemOrange` / `systemRed` tint | Generic status pills paired with `foreground` (`label`) text | `color-mix(in srgb, var(--primary\|success\|warning\|destructive) 16%, transparent)` | `color-mix(in srgb, var(--primary\|success\|warning\|destructive) 24%, transparent)` |
| `host-starting` / `-foreground` | `systemBlue` tint / `label` | Host `starting` state (`◐ Starting`) | `var(--badge-primary)` / `#000000` | `var(--badge-primary)` / `#ffffff` |
| `host-running` / `-foreground` | `systemGreen` tint / `label` | Host `running` state (`● Running`) | `var(--badge-success)` / `#000000` | `var(--badge-success)` / `#ffffff` |
| `host-restarting` / `-foreground` | `systemOrange` tint / `label` | Host `restarting` state (`↻ Restarting`) | `var(--badge-warning)` / `#000000` | `var(--badge-warning)` / `#ffffff` |
| `host-stopped` / `-foreground` | `systemFill` / `label` | Host `stopped` state (`■ Stopped`) | `rgba(120, 120, 128, 0.2)` / `#000000` | `rgba(120, 120, 128, 0.36)` / `#ffffff` |
| `host-failed` / `-foreground` | `systemRed` tint / `label` | Host `failed` state (`▲ Failed`) | `var(--badge-danger)` / `#000000` | `var(--badge-danger)` / `#ffffff` |

**Accepted contrast trade-off (#2540)**: Using the iOS system values as-is leaves white labels on `systemBlue` filled buttons below WCAG 4.5:1 (`4.0:1` light `#007aff`, `3.65:1` dark `#0a84ff`), and `systemOrange` / `systemGreen` status text lighter on light backgrounds. This is accepted to match iOS: status never relies on color alone (glyph + label), and status pills (`Badge` and `host-*`) use `label` text (`#000000` / `#ffffff`) on a system-color tint. If a target later requires WCAG AA, adopt Apple's iOS Increase Contrast variants rather than custom hexes.

---

## 4. Platform Typography & CJK Invariant (ADR-052 D4)

- **Default UI font**: Platform native sans (`font-sans` omitted/default).
- **Monospace**: Used only for identifiers, bridge method names, shortcuts, and `tabular-nums` aligned numbers (`font-mono`).
- **Windows CJK `<Input>` / `<Textarea>` invariant**:
  - `nsh.json` defines `"tailwind": { "fontFamily": { "cjk": "Microsoft YaHei UI" } }`.
  - Both `Input` and `Textarea` in `src/ui/Input.tsx` apply `font-cjk` whenever `platform.os === "windows"` so Chinese characters never fall back to Windows `"Segoe UI"` tofu (`□□□□`). Feature screens never import raw `"nsh/base"` `Input` and never specify font families individually.
- **No uppercase or expanded tracking on CJK labels**.

---

## 5. Motion Tokens & Policy

Motion explains state transitions without delaying immediate desktop actions:

| Token | Value | Use |
| --- | --- | --- |
| `instant` | `duration-100` (`~100–120ms`) | Hover wash, border/color state transition (`ease-out`) |
| `fast` | `duration-150` (`~150–180ms`) | Button press scale (`0.97`), icon button press (`0.95`), popup exit (`ease-in`) |
| `base` | `duration-200` (`~200–240ms`) | Toggle switch thumb slide, collapsible height reveal, overlay enter (`ease-out` / `ease-in-out`) |
| `slow` | `duration-300` (`~300–360ms`) | Dialog / Sheet presentation (`fade` + subtle scale/slide) |
| **Reduced motion** | `motion-reduce:*` & `reduceMotion()` | Transitions become instant; press scale clamps to `1.0`; collapsible `reveal` and continuous spinner animations pause or simplify cleanly. |

---

## 6. Motion Inventory — Foundations & Gallery Screen

Written before `src/ui/` implementation. Every state change on the Gallery screen accounts for tool, tokens, and `reduceMotion`:

| State Change | Tool & Tokens | Reduced Motion Behavior |
| --- | --- | --- |
| Hover & press on `Button`, `IconButton`, `MenuItem` | Transition colors (`duration-100 ease-out`), press scale `active:scale-[0.97]` (`active:scale-[0.95]` on `IconButton`) with `duration-150 ease-out` | `motion-reduce:transition-none motion-reduce:active:scale-100` |
| Glyph / label swap (Disclosure chevron, Copy/Submitted status, Spinner active) | Disclosure chevron & expand state swap cleanly; interactive state color fade `duration-150` | `motion-reduce:transition-none`; state remains explicit via label & symbol |
| Selection movement (`Tabs` Gallery appearance switcher, `Switch` thumb, `Checkbox` tick) | Switch thumb `transition-transform duration-200 ease-in-out`; Tab/Checkbox state wash `duration-150` | `motion-reduce:transition-none` (thumb jumps cleanly to end state) |
| Content arriving or leaving (`Toast` banner, Host-state preview swap) | `Toast` enters/exits natively; Gallery list sections are static so no staggered wave needed (`none`) | Instant appearance/disappearance; state remains legible via text + glyph |
| Surface opening or closing (`Dialog`, `Sheet`, `Popover`, `Menu`, `Tooltip`) | `Dialog` (`animation="slide"` or `"fade"` when `reduceMotion()`); Popover/Menu/Tooltip share `duration-150` fade/scale popup chrome | `reduceMotion()` forces `animation="none"` on `Dialog`/`Sheet`; popups appear immediately |
| User-triggered layout change (`Disclosure` / `Collapsible` expand/collapse) | `Collapsible reveal={!reduceMotion()}` native clipped height spring | `reveal={false}` — expands/collapses immediately without height animation |
| Drag / swipe / throw | None (Foundations Gallery contains no draggable sliders/splitters/drawers) | N/A |
| Loading & progress (`Button loading`, `Spinner`, `Skeleton`) | Spinner shows visual + accessible loading status (`accessibilityState={{ busy: true }}`), `Skeleton` subtle muted bar | Continuous spin omitted/static indicator shown under `reduceMotion()`, busy state label preserved |
| Live / continuous updates | None in Gallery (live Host stream belongs to Shell/Conversation feature slices) | N/A |

---

## 7. Motion Inventory — Keys Screen (Slice 2)

Written before `KeysScreen.tsx` implementation. Every state transition accounts for tool, tokens, and `reduceMotion()`:

| State Change | Tool & Tokens | Reduced Motion Behavior |
| --- | --- | --- |
| Stored provider row selection & hover wash (`keys.list`) | `ListItem` `MOTION_CLASSES.interactiveColor` (`transition-colors duration-100 ease-out`) highlighting selected `bg-sidebar-accent` row | `motion-reduce:transition-none`; selection state stays explicit via `accessibilityState={{ selected }}` and trailing active indicator |
| Busy section lock during `keys.list` / `keys.submit` / post-receipt reload | `Button loading={busy()}` shows inline `Spinner` + `accessibilityState={{ busy: true }}`; fields disable immediately with `disabled:opacity-50` without layout shift | `motion-reduce:` stops continuous spin animation while preserving busy text & disabled state |
| Dynamic visible fields from `modelRouteView()` (vendor / auth / pi_model swaps) | Clean instant conditional mount (`<For>` / `<If>`) aligned along uniform `Field` vertical spine; zero jittery reflow | Identical instant mount/unmount; error and required markers stay explicit in text |
| Select dropdown open/close (`provider_kind`, `adapter`, `auth_mode`, `thinking_level`, `model`) | `Select` popup chrome uses `MOTION_CLASSES.popupTransition` + `popupStarting` / `popupEnding` (`duration-150` fade/scale) | `motion-reduce:transition-none` — opens/closes immediately |
| Secret input clearing & submission feedback | Masked `Input` `MOTION_CLASSES.interactiveColor`; secret signal clears synchronously before `keys.submit` FFI transfer; `Receipt` (`role="region"` + `accessibilityLiveRegion="polite"`) or `RefusalNote` (`role="alert"`) appears cleanly in-flow | `motion-reduce:transition-none`; secret-free receipt and typed refusal code appear immediately |
| `ReplaceKeyForm` mount when editing `auth_mode !== "none"` stored profile | Conditional card section for stored-profile credential replacement + `configuration_pending` `Badge` (`warning` symbol + label) | Instant show/hide; status relies on explicit label & symbol, never color alone |

---

## 8. Motion Inventory — Shell & Recovery (Slice 3)

Written before Slice 3 implementation. Every state change across workspace navigation, Host supervision, recovery dialogs, tray/window lifecycle, and login item toggles accounts for tool, tokens, and `reduceMotion()`:

| State Change | Tool & Tokens | Reduced Motion Behavior |
| --- | --- | --- |
| Sidebar workspace section selection (`Conversation`, `Activity`, `Settings`, `Keys`; `Gallery` in development builds only) | `ListItem` `MOTION_CLASSES.interactiveColor` (`duration-100 ease-out`) on active `bg-sidebar-accent`; main panel swaps via conditional `<If>` mount (zero hidden trees) | `motion-reduce:transition-none`; active row stays explicit via `accessibilityState={{ selected }}` |
| Toast notices (Keys save receipt or refusal, Gallery demos) | `ToastRegion` stacks up to four `Toast`s bottom-right; each enters and leaves with `MOTION_CLASSES.popupTransition` (`duration-150 ease-out`) from `popupStarting` to `popupEnding` (`opacity-0 scale-95`); Escape on the stack clears them all | `motion-reduce:transition-none`; a toast appears and leaves at once, its tone stays explicit via icon and title |
| Live Host status badge transitions (`HostStateBadge`) | Semantic host-state token colors + distinct symbol (`◐`/`●`/`↻`/`■`/`▲`) + label; Gallery previews write to an isolated preview signal so live `hostReady()` is unaffected | Instant pill swap without color transition; non-color symbol & label always shown |
| Recovery panel (`stopped` / `failed`), `Dialog` confirmations, and diagnostics export | `Dialog` (`role="alertdialog"`, `animation={dialogAnimation()}`) handles Escape dismissal and focus restore cleanly; shared `recoveryBusy` (and, for the diagnostics export, quitting) disables buttons without layout shift; diagnostics output (stopped card only: the failed card's Host has exited, so it points to Restart Host) announces via `accessibilityLiveRegion="polite"` | `dialogAnimation()` resolves to `"none"`; status & refusal banners appear immediately |
| Restart Host from the sidebar, recovery card, tray, application menu, or its `mod+shift+r` shortcut | No animation: every entry calls the guarded store `restartHost()`; the menu item and its shortcut disable on the shared quitting / recovery-busy / starting predicate; the sidebar and card buttons show `Button loading` while the restart runs | Spinner stops under `motion-reduce:`; busy and disabled states stay explicit |
| Tray menu, close-to-tray hide, and `reopen` / `secondInstance` show | Window hides in place (`closeOnPress: false` -> `win.hide()`) and restores via unified store `showMainWindow()`, preserving mounted UI state & in-flight locks | Identical instant hide/show window transitions |
| Login item toggle (`settings.loginItem` / `settings.setLoginItem`) | `Switch` thumb `MOTION_CLASSES.switchThumb` (`transition-transform duration-200 ease-in-out`) reflects OS-authoritative state after bridge resolution; Linux displays explicit unsupported notice | `motion-reduce:transition-none`; switch state jumps cleanly to resolved OS boolean |

---

## 9. Motion Inventory — Conversation Workspace (Slice 4)

Written before `src/features/conversation/` implementation. Every state change in the bot rail, profile editor, transcript, and composer accounts for tool, tokens, and `reduceMotion()`:

| State Change | Tool & Tokens | Reduced Motion Behavior |
| --- | --- | --- |
| Bot rail selection & hover wash | `ListItem` `MOTION_CLASSES.interactiveColor` (`duration-100 ease-out`) on the selected `bg-sidebar-accent` row; the selected Bot's conversation swaps in only once its own `k8.view` read lands (no stale transcript under the new header) | `motion-reduce:transition-none`; selection stays explicit via `accessibilityState={{ selected }}` |
| Bot state badge changes (`Idle`, `Working`, `Waiting for you`, `Profile updating`, `Runtime unavailable`, `Archived`) | `Badge` pill swap: semantic tone plus symbol and label, so state never relies on color alone | Instant swap; symbol and label always shown |
| "New by role" list open/close | `Disclosure` (`Collapsible reveal={!reduceMotion()}`) | `reveal={false}`: expands and collapses at once |
| Profile editor replacing the conversation pane (create / edit / close) | Instant conditional `<If>` mount on the same `Field` spine; Save and Archive show `Button loading` while their command runs | Identical instant mount; busy and error text stay explicit |
| Archive confirmation | `Dialog role="alertdialog"` with `animation={dialogAnimation()}`; focus moves into the dialog and returns on close; Escape keeps the Bot | `dialogAnimation()` resolves to `"none"`: the dialog appears and leaves at once |
| Streaming reply (`working` row draft) | `MarkdownView streaming` (`TextView` `options={{ streaming: true }}`): only changed blocks re-render, with a static `▍` caret after the last block; no fade or typewriter effect | Same: text appears as it arrives; the caret is static, never blinking |
| New rows and row updates in the transcript | `List` keyed by the Host's stable item keys (`e<seq>` / `t<turnId>` / `q<questionId>`), `alignment="bottom"`, `initialScrollAtEnd`, and `maintainVisibleContentPosition` so streaming text and new messages keep the reading position; rows insert without enter animation | No animation either way; scroll position rules are unchanged |
| Folded history toggle (rows above the latest clear) | `Button` label swap (`Show N earlier messages` / `Hide N earlier messages`); the open state lives in the store per Bot, so switching Bots or sections keeps it; a Bot that leaves the Host's snapshot drops it | Instant show/hide of the folded rows |
| Send / Cancel Turn / Clear context / Answer | `Button loading` while the command runs; a failed command shows `role="alert"` text in flow without layout shift of the controls | Spinner stops under `motion-reduce:`; busy and disabled states stay explicit |
| `k8.view` failure | The last snapshot stays on screen; a `role="alert"` banner with Retry appears above it | Instant appearance |
| Drag / swipe / throw | None in this workspace | N/A |

---

## 10. Motion Inventory — Activity & Settings (Slice 5)

Written before `src/features/activity/` and `src/features/settings/` implementation. Every state change in the activity cards, approval decisions, device facts, and Dreaming preferences accounts for tool, tokens, and `reduceMotion()`:

| State Change | Tool & Tokens | Reduced Motion Behavior |
| --- | --- | --- |
| Activity cards arriving, updating, or leaving (`activity.cards` on section entry, each Host state hint, Retry, and after a decision) | `List` (`viewport="parent"`) keyed by `taskId`; each recycled cell mounts its card by the current `taskId`, so a reused cell carries no state of the card it showed before; rows insert and update without enter animation | No animation either way; content is the same |
| Card timeline expand/collapse | `Disclosure` (`Collapsible reveal={!reduceMotion()}`); the expanded set lives in the store by `taskId`, so a reload, a recycled cell, or a section switch keeps it | `reveal={false}`: expands and collapses at once |
| Approval status changes (`pending` → `approved` / `rejected`, by either entry) | `Badge` pill swap: semantic tone plus symbol (`◐` / `✓` / `✕`) and label, so status never relies on color alone; a pending approval sits outside the `Disclosure`, so it shows while the card is folded | Instant swap; symbol and label always shown |
| Approve / Reject confirmation | Native `confirmAlert` (`AlertDialog`, the OS alert dialog): the platform presents it, moves focus in and back, and Escape cancels it (`closeOnEscape`) | The OS alert follows the system's reduced-motion setting |
| Approve / Reject running and its result | `Button loading` while the decision runs (both buttons disabled); a Host refusal (a stale approval included) shows `role="alert"` text in flow and the cards reload to the decided state | Spinner stops under `motion-reduce:`; busy and disabled states stay explicit |
| `activity.cards` failure | A `role="alert"` banner with Retry replaces the list; no stale cards stay on screen | Instant appearance |
| Settings load and Refresh (`settings.device`, `settings.get`) | Loads only when the section shows or Refresh is pressed; `Button loading` on Refresh; device facts, runtimes, and doctor checks swap in at once when the read lands | Spinner stops under `motion-reduce:`; content appears at once |
| Runtime verdict and doctor status badges | `Badge` with tone plus symbol (`✓` / `!` / `✕`, `?` when none reported) and label | Instant swap; symbol and label always shown |
| Dreaming switch and model choice | `Switch` thumb `MOTION_CLASSES.switchThumb` (`duration-200 ease-in-out`); `Checkbox` state wash `duration-150`; the `#1` / `#2` order label swaps in the row label | `motion-reduce:transition-none`: thumb and tick jump to the end state; order stays explicit in text |
| Dreaming save | `Button loading` while `settings.setDreaming` runs; Refresh shows `Button loading` and stays disabled until the save settles, also after a section switch remounts Settings (its read waits for the save); Save in turn disables while a settings read runs; the result shows in a polite live region, a failure as `role="alert"` text | Spinner stops under `motion-reduce:`; result text appears at once |
| Diagnostics export while the Host is not running | The button disables and a muted note explains why, in flow without layout shift | Identical |
| Drag / swipe / throw | None in these workspaces | N/A |
