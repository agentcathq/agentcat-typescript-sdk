# Contributing to AgentCat 🎉

Thank you for your interest in contributing to AgentCat! We're excited to have you join our community of developers building analytics tools for MCP servers.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/agentcat-typescript-sdk.git
   cd agentcat-typescript-sdk
   ```
3. **Install dependencies** using pnpm:
   ```bash
   pnpm install
   ```
4. **Create a branch** for your feature or fix:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

## Development Process

### Making Changes

1. **Write your code** following our TypeScript standards
2. **Add tests** for new features (required for feature additions)
3. **Run the test suite** to ensure everything passes:
   ```bash
   pnpm test
   ```
4. **Check your code** meets our standards:
   ```bash
   pnpm lint        # Run ESLint
   pnpm typecheck   # Run TypeScript compiler checks
   ```

### Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/). Your commit messages should be structured as:

```
<type>: <description>

[optional body]
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Adding or updating tests
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `chore`: Changes to build process or auxiliary tools

**Examples:**

```bash
git commit -m "feat: add telemetry exporters for observability"
git commit -m "fix: handle edge case in session tracking"
git commit -m "docs: update API documentation"
```

## Pull Request Process

1. **Push your changes** to your fork:

   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a Pull Request** from your fork to our `main` branch

3. **Fill out the PR description** with:

   - What changes you've made
   - Why these changes are needed
   - Any relevant context or screenshots

4. **Wait for review** - The AgentCat team will review your PR within 2 business days

5. **Address feedback** if any changes are requested

6. **Celebrate** 🎉 once your PR is merged!

### No Issue Required

You don't need to open an issue before submitting a PR. Feel free to submit pull requests directly with your improvements!

## Good First Issues

Looking for a place to start? Check out issues labeled [`good first issue`](https://github.com/agentcathq/agentcat-typescript-sdk/labels/good%20first%20issue) - these are great for newcomers to the codebase.

## Testing

- New features **should include tests** to ensure reliability
- Run tests locally with `pnpm test`
- We use [Vitest](https://vitest.dev/) for our test suite
- Test files should be placed next to the code they test with `.test.ts` extension

## Code Quality

Before submitting your PR, ensure your code passes all checks:

```bash
# Run all checks at once
pnpm run prepublishOnly

# Or run them individually
pnpm run build      # Build the project
pnpm test          # Run tests
pnpm lint          # Check code style
pnpm typecheck     # Check TypeScript types
```

Our CI will run these same checks on your PR.

## Dependencies

While we don't restrict adding new dependencies, they are generally **discouraged** unless absolutely necessary. If you need to add a dependency:

1. Consider if the functionality can be achieved with existing dependencies
2. Check if the dependency is well-maintained and lightweight
3. Ensure it's compatible with our MIT license
4. Add it using pnpm: `pnpm add <package-name>`

## Project Structure

```
agentcat-typescript-sdk/
├── src/           # Source code
│   ├── tests/     # Test files
│   └── index.ts   # Main entry point
├── dist/          # Built output (generated)
└── docs/          # Documentation
```

## Community

- **Discord**: Join our [Discord server](https://discord.gg/n9qpyhzp2u) for discussions
- **Documentation**: Visit [docs.agentcat.com](https://docs.agentcat.com) for detailed guides
- **Issues**: Browse [open issues](https://github.com/agentcathq/agentcat-typescript-sdk/issues) for areas needing help

## Record your change

Every change that a user can see adds an entry to the `[Unreleased]` section of `CHANGELOG.md`
in its pull request. The release notes come from this section.

## Release a version

The release workflow (`.github/workflows/release.yml`) does the release in two steps, with a pull
request between them. The Java and Rust SDKs release the same way.

1. In GitHub, open **Actions > Release > Run workflow** on `main`. Keep `patch`, or type `minor`,
   `major` or an exact version such as `2.2.0`. The words count from the newest `v*` tag.
2. The workflow opens the pull request "Release vX.Y.Z". It sets the version in `package.json`,
   and turns `[Unreleased]` into the dated section of the version. It also starts CI and the MCP
   SDK compatibility tests on the pull request. An `[Unreleased]` section with no entry, or a
   version that npm already has, stops the workflow.
3. Read the pull request, and merge it when CI passes.
4. The merge starts the workflow again. It waits for CI and the compatibility tests on the merge
   commit and publishes the package to npm with the `latest` dist-tag. Then it creates the tag
   `vX.Y.Z` and its GitHub release, with the CHANGELOG section as the notes.

If a step fails, fix the cause and re-run the failed jobs of that run. The publish step skips a
version that npm already has, and the tag comes last.

Do not run `npm publish` for a release version on your machine. npm never accepts a version
twice, not even an unpublished one, so a local publish can use up a version for good. Only the
release workflow publishes `X.Y.Z` versions.

The workflow releases only versions `X.Y.Z`. A pre-release (for example `2.2.0-beta.1` with the
`beta` dist-tag) stays a manual task: set the version in `package.json` on a branch, and run
`npm publish --tag beta` from that branch. Do not merge that version into `main`, and do not tag
it `vX.Y.Z`.

To run a step of the workflow by hand, use `node scripts/release.mjs prepare <patch | minor |
major | X.Y.Z> <YYYY-MM-DD>`, `status` or `notes <X.Y.Z>`. `scripts/release.test.mjs` tests these
steps; CI runs it with `node --test scripts/release.test.mjs`.

The publish job uses npm trusted publishing: npm trades the OIDC token of the job for a
short-lived publish token, so GitHub stores no npm secret. npm also publishes a provenance
statement (Sigstore) for each version, because the repository is public. To make sure that an
installed version came from this workflow, run `npm audit signatures` in a project that depends
on `agentcat`, or open the version on npmjs.com and read its **Provenance** section.

The job builds the package with `pnpm run build`, packs it with `npm pack --ignore-scripts`, and
publishes the tarball with `npm publish`. A tarball publish runs no lifecycle script, so
`prepublishOnly` does not run the test suite a second time: CI on the merge commit already ran
it.

### One-time setup

- In the repository settings, turn on **Actions > General > Allow GitHub Actions to create and
  approve pull requests**, so that the workflow can open the release pull request.
- Create a `release` environment, limited to the `main` branch.
- On npmjs.com, a maintainer of `agentcat` opens **Packages > agentcat > Settings > Trusted
  publishing**, selects **GitHub Actions**, and adds a trusted publisher: the organization
  `agentcathq`, the repository `agentcat-typescript-sdk`, the workflow `release.yml` and the
  environment `release`, with `npm publish` allowed. The first publish must come within 2 days,
  or the trusted publisher expires.
- After the first release through the workflow, set **Settings > Publishing access** of the
  package to **Require two-factor authentication and disallow tokens**, and revoke the npm
  tokens that published by hand.

## Recognition

All contributors are recognized in our repository. Your contributions help make AgentCat better for everyone building MCP servers!

## Questions?

If you have questions about contributing, feel free to:

- Ask in our [Discord server](https://discord.gg/n9qpyhzp2u)
- Open a [discussion](https://github.com/agentcathq/agentcat-typescript-sdk/discussions) on GitHub

Thank you for contributing to AgentCat! 🐱
