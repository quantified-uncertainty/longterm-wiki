## 2026-02-18 | claude/mobile-sidebar-collapse-aM9Hd | Mobile sidebar collapse

**What was done:** Added mobile sidebar support — on screens below 768px, the static sidebar is hidden and replaced with a hamburger trigger button that opens a slide-out overlay panel with smooth transitions. Auto-closes on route navigation, Escape key, and backdrop click.

**Model:** opus-4-6

**Duration:** ~20min

**Issues encountered:**
- None

**Learnings/notes:**
- `SidebarTrigger` component existed but was never used — created separate `MobileSidebar` and `MobileSidebarTrigger` components with dedicated mobile context to avoid coupling desktop and mobile state
- No Sheet/Dialog radix primitive was installed, so built the overlay with plain CSS transitions (opacity + transform) to avoid adding dependencies
