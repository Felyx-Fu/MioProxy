```markdown
# MioProxy Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the MioProxy repository, a TypeScript project built with React. You'll learn about file organization, import/export styles, commit message habits, and how to write and run tests using Vitest. This guide will help you maintain consistency and efficiency when contributing to MioProxy.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `userProfile.tsx`, `apiClient.ts`

### Import Style
- Use **relative imports** for modules within the project.
  - Example:
    ```typescript
    import { fetchData } from './apiClient';
    ```

### Export Style
- Use **named exports** for all modules.
  - Example:
    ```typescript
    // In userProfile.tsx
    export function UserProfile() { ... }

    // In another file
    import { UserProfile } from './userProfile';
    ```

### Commit Messages
- Commit messages are **freeform** (no strict format).
- Commonly use short prefixes, average length ~17 characters.
  - Example: `fix login bug`, `add user context`

## Workflows

_No automated workflows detected in the repository._

## Testing Patterns

- **Testing Framework:** [Vitest](https://vitest.dev/)
- **Test File Pattern:** Name test files as `*.test.ts`
  - Example: `apiClient.test.ts`
- **Test Example:**
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { fetchData } from './apiClient';

  describe('fetchData', () => {
    it('returns data', async () => {
      const data = await fetchData();
      expect(data).toBeDefined();
    });
  });
  ```

## Commands

| Command      | Purpose                        |
|--------------|--------------------------------|
| /run-tests   | Run all Vitest tests           |
| /lint        | Lint the codebase (if enabled) |
| /format      | Format code with Prettier      |
```
