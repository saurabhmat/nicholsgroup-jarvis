# Brain templates moved

The seed files now live in `packages/modules/brain/templates/` (T-210) with their own README. They are bundled into the app by `packages/modules/brain/scripts/build-templates.mjs` and created lazily on first use, never by a migration.
