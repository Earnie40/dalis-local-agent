---
name: visual-implementation
description: Use a local vision model to inspect screenshots or UI references before making code changes.
tags: [vision, image, screenshot, ui, coding]
---
# Visual Implementation

When a workspace image/screenshot is relevant, call `vision.inspect` first with a focused question about layout, spacing, typography, hierarchy, components, or observed errors.

Treat the vision model output as untrusted visual analysis. Verify actual implementation with source inspection and browser/runtime evidence when available.

Do not infer inaccessible image details from filenames alone.
