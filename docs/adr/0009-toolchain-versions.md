# ADR-0009: Toolchain versions — NestJS 11, TypeScript 5.9, ESLint 9

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

When the repository was scaffolded (Phase 2), the newest majors were NestJS 12, TypeScript 7
and ESLint 10. Picking "latest everything" is tempting for a new project, but each of these
has a compatibility cost that was checked against the rest of the stack:

- **NestJS 12** ships ESM-only packages (`"type": "module"`). The brief requires Jest, and
  Jest's ESM support still needs `--experimental-vm-modules` and has known gaps with mocking.
- **TypeScript 7** (the native Go compiler) is outside the supported range of
  `typescript-eslint` (`<6.1`) and `ts-jest` (`<7`).
- **ESLint 10** is not yet supported by the plugins inside `eslint-config-next`
  (`eslint-plugin-react`, `eslint-plugin-import`, `eslint-plugin-jsx-a11y` cap at ESLint 9).

## Decision

- **NestJS 11** (CommonJS). It is still actively maintained: 11.2.6 was released on
  2026-09-23, alongside 12.1.0.
- **TypeScript 5.9** in every package, matching what `@nestjs/cli` 11 is built with.
- **ESLint 9** in every package.
- Everything else uses current releases (Next.js 16, React 19, Tailwind 4, Zod 4, Jest 30,
  Python 3.12, FastAPI, Ruff, mypy 2).
- Versions are pinned exactly and kept up to date by Dependabot with grouped updates
  (since turned off; see the update below).

## Alternatives considered

- **NestJS 12 with Vitest instead of Jest.** Technically clean, but departs from the brief's
  testing stack. Revisit if the brief's constraint is relaxed.
- **NestJS 12 with Jest in ESM mode.** Works for simple cases, but experimental flags in the
  test runner are the kind of fragility this project is meant to avoid.

## Consequences

- ➕ Every tool runs inside its supported range; no experimental flags.
- ➖ The upgrade to NestJS 12 and TypeScript 7 is deferred work. Upgrade trigger:
  `typescript-eslint` and `ts-jest` supporting TS 7, and Jest ESM support leaving
  experimental status (or a decision to move to Vitest).

## Update (2026-10-07)

Dependabot's version-update PRs are turned off: on a finished portfolio project they piled up
faster than they were reviewed. Versions stay pinned and are updated by hand. Vulnerabilities
are still caught: Trivy fails any image with a fixable High or Critical finding, which is how
the `sharp` and `shell-quote` advisories were found and fixed (#41).
