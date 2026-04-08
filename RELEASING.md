# Releasing

This project keeps release history in `CHANGELOG.md` and uses GitHub Releases plus npm publishes for distribution.

## Standards

- Every user-visible, packaging, CI, or release-process change goes into `CHANGELOG.md` under `## [Unreleased]`.
- Every release gets a versioned changelog section before the GitHub release is created.
- Git tags must match `package.json` exactly: `vX.Y.Z` for package version `X.Y.Z`.
- GitHub release notes should be generated with GitHub's auto notes and then edited to match the changelog summary when needed.

## Release checklist

1. Confirm `main` is green.
2. Update `CHANGELOG.md`.
3. Move the relevant items from `## [Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section.
4. Bump the package version:

```bash
npm version X.Y.Z --no-git-tag-version
```

5. Commit the release prep with a short subject line.
6. Push `main` and wait for CI to finish successfully.
7. Create the GitHub release with generated notes:

```bash
gh release create vX.Y.Z \
  --target main \
  --title vX.Y.Z \
  --generate-notes
```

8. Review the generated notes before publishing the release. The notes should align with the new `CHANGELOG.md` section.
9. Wait for the `Publish` workflow to complete.
10. Verify the package on npm:

```bash
npm view inboxctl version dist-tags.latest
```

## If a release is created too early

If a GitHub release is created before the version bump commit lands on `main`, delete the release and tag, fix `package.json` and `CHANGELOG.md`, then cut a new release from the corrected commit.

```bash
gh release delete vX.Y.Z --cleanup-tag --yes
```

## Notes

- The publish workflow validates tag and package version alignment.
- The publish workflow also requires a matching section in `CHANGELOG.md`.
- `.github/release.yml` controls the categories used by GitHub's generated release notes.
