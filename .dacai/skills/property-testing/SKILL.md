---
name: property-testing
description: Turn invariants into property-based tests and use mutation testing to assess test strength.
tags: [testing, property, fuzz, mutation, coding]
---
# Property and Mutation Testing

For logic with meaningful invariants:
1. State the invariant clearly.
2. Add a focused property test using `fast-check`.
3. Bound generated input sizes and run count.
4. Use `quality.test_file` to run the exact test.
5. For high-value logic, use `quality.mutation` on the narrow implementation file.
6. Treat surviving meaningful mutants as evidence that tests may be weak.

Do not run mutation testing across the whole monorepo by default.
