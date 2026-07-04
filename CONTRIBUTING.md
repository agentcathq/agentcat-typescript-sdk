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

## Versioning

The AgentCat team handles versioning and releases. Your contributions will be included in the next appropriate release based on semantic versioning principles.

## Recognition

All contributors are recognized in our repository. Your contributions help make AgentCat better for everyone building MCP servers!

## Questions?

If you have questions about contributing, feel free to:

- Ask in our [Discord server](https://discord.gg/n9qpyhzp2u)
- Open a [discussion](https://github.com/agentcathq/agentcat-typescript-sdk/discussions) on GitHub

Thank you for contributing to AgentCat! 🐱
