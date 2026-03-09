# Version Bump Workflow

When creating a new development version from an existing stable version.

## Steps

1. **Copy the version folder**
   ```
   cp -r mvp/SVphone_vXX_XX mvp/SVphone_vYY_YY
   ```

2. **Update `.gitignore`** — Add tracking entries for the new version:
   ```
   !mvp/SVphone_vYY_YY/
   !mvp/SVphone_vYY_YY/**
   ```

3. **Update `build.mjs:4`** — Change the VERSION constant:
   ```js
   const VERSION = 'vYY.YY'
   ```

4. **Update `.cpanel.yml`** — Point all deployment paths to the new version:
   ```
   SVphone_vXX_XX -> SVphone_vYY_YY
   ```

5. **Commit and push** — Include the new version folder, .gitignore, .cpanel.yml, and build.mjs changes.
